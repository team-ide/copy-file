// @ts-nocheck
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// ============ 配置 ============
const MAX_FILES = 2000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_DEPTH = 30;

const SUPPORTED_EXTS = new Set([
	'.js', '.jsx', '.mjs', '.cjs',
	'.ts', '.tsx', '.mts', '.cts',
	'.vue', '.svelte',
	'.dart',
	'.go',
	'.java', '.kt', '.kts',
]);

const RESOLVE_EXTS = [
	'', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.vue', '.svelte', '.dart', '.go', '.java', '.kt', '.kts',
	'.json',
];

const IGNORE_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
	'target', '.idea', '.vscode', '.gradle', 'vendor', '.dart_tool',
	'coverage', '.next', '.nuxt', '.cache',
]);

const IGNORE_EXTS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
	'.mp3', '.mp4', '.avi', '.mov', '.wav',
	'.zip', '.tar', '.gz', '.rar', '.7z',
	'.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war',
	'.lock', '.log', '.min.js', '.min.css',
]);

// ============ 主入口 ============
function activate(context) {
	const disposable = vscode.commands.registerCommand(
		'copy-file.copyRelatedContent',
		async (uri) => {
			const targetUri = uri instanceof vscode.Uri
				? uri
				: vscode.window.activeTextEditor?.document.uri;

			if (!targetUri || targetUri.scheme !== 'file') {
				vscode.window.showWarningMessage('请右键点击一个本地文件或目录。');
				return;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('该路径不在任何工作区内。');
				return;
			}

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '收集文件...',
						cancellable: false,
					},
					async (progress) => {
						const collector = new DependencyCollector(
							workspaceFolder.uri.fsPath,
							progress
						);
						const files = await collector.collect(targetUri.fsPath);

						if (files.length === 0) {
							vscode.window.showWarningMessage('未找到可复制的文件。');
							return;
						}

						const output = formatOutput(files, workspaceFolder.uri.fsPath);
						await vscode.env.clipboard.writeText(output);

						const totalBytes = files.reduce((s, f) => s + f.content.length, 0);
						vscode.window.showInformationMessage(
							`已复制 ${files.length} 个文件（约 ${formatBytes(totalBytes)}）到剪贴板。`
						);
					}
				);
			} catch (err) {
				vscode.window.showErrorMessage(`复制失败：${err && err.message ? err.message : err}`);
			}
		}
	);

	context.subscriptions.push(disposable);
}

function deactivate() { }

// ============ Go 模块信息 ============
/**
 * 读取工作区（或文件所在目录向上查找）的 go.mod，解析模块名
 * @param {string} startDir
 * @returns {{ moduleName: string, goModDir: string } | null}
 */
function findGoModule(startDir) {
	let dir = startDir;
	while (true) {
		const goModPath = path.join(dir, 'go.mod');
		if (fs.existsSync(goModPath)) {
			try {
				const content = fs.readFileSync(goModPath, 'utf8');
				const m = content.match(/^\s*module\s+(\S+)/m);
				if (m) {
					return { moduleName: m[1].trim(), goModDir: dir };
				}
			} catch { /* ignore */ }
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ============ 依赖收集器 ============
class DependencyCollector {
	constructor(workspaceRoot, progress) {
		this.workspaceRoot = workspaceRoot;
		this.progress = progress;
		this.visited = new Set();
		this.files = [];
		this.queue = [];
		this.goModuleCache = null;
		this.goModuleLoaded = false;
	}

	/**
	 * 延迟加载 go.mod 信息
	 * @param {string} fromFile
	 */
	getGoModule(fromFile) {
		if (this.goModuleLoaded) return this.goModuleCache;
		this.goModuleLoaded = true;
		this.goModuleCache = findGoModule(path.dirname(fromFile));
		return this.goModuleCache;
	}

	async collect(startPath) {
		let stat;
		try {
			stat = await fs.promises.stat(startPath);
		} catch {
			return [];
		}

		if (stat.isDirectory()) {
			const allFiles = await this.walkDirectory(startPath);
			for (const f of allFiles) {
				this.queue.push({ absPath: f, depth: 0 });
			}
			this.progress.report({
				message: `目录下发现 ${allFiles.length} 个文件，开始解析依赖...`,
				increment: 10,
			});
		} else {
			this.queue.push({ absPath: startPath, depth: 0 });
		}

		while (this.queue.length > 0) {
			if (this.files.length >= MAX_FILES) {
				vscode.window.showWarningMessage(`文件数已达上限 ${MAX_FILES}，停止收集。`);
				break;
			}

			const { absPath, depth } = this.queue.shift();
			if (this.visited.has(absPath)) continue;
			this.visited.add(absPath);
			if (depth > MAX_DEPTH) continue;

			const fileData = await this.readFile(absPath);
			if (!fileData) continue;

			this.files.push(fileData);
			if (this.files.length % 10 === 0) {
				this.progress.report({
					message: `已收集 ${this.files.length} 个文件...`,
					increment: 1,
				});
			}

			const ext = fileData.ext;
			if (!SUPPORTED_EXTS.has(ext)) continue;

			let deps = [];
			try {
				deps = extractDependencies(ext, fileData.content, absPath);
			} catch (e) {
				console.warn(`解析依赖失败: ${absPath}`, e);
			}

			for (const spec of deps) {
				// 一个依赖可能解析出多个文件（Go 包目录下的多个 .go）
				const resolved = this.resolveDependency(absPath, spec);
				if (!resolved) continue;
				if (Array.isArray(resolved)) {
					for (const r of resolved) {
						this.queue.push({ absPath: r, depth: depth + 1 });
					}
				} else {
					this.queue.push({ absPath: resolved, depth: depth + 1 });
				}
			}
		}

		this.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
		return this.files;
	}

	async walkDirectory(dir) {
		const result = [];
		const stack = [dir];

		while (stack.length > 0) {
			const current = stack.pop();
			let entries;
			try {
				entries = await fs.promises.readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				const full = path.join(current, entry.name);

				if (entry.isDirectory()) {
					if (IGNORE_DIRS.has(entry.name)) continue;
					if (entry.name.startsWith('.')) continue;
					stack.push(full);
				} else if (entry.isFile()) {
					if (this.shouldIgnoreFile(entry.name)) continue;
					result.push(full);
					if (result.length >= MAX_FILES) return result;
				}
			}
		}

		return result;
	}

	shouldIgnoreFile(name) {
		const lower = name.toLowerCase();
		for (const ext of IGNORE_EXTS) {
			if (lower.endsWith(ext)) return true;
		}
		return false;
	}

	async readFile(absPath) {
		try {
			const stat = await fs.promises.stat(absPath);
			if (!stat.isFile()) return null;
			if (stat.size > MAX_FILE_SIZE) {
				console.warn(`跳过过大文件: ${absPath}`);
				return null;
			}

			const buffer = await fs.promises.readFile(absPath);

			const head = buffer.subarray(0, Math.min(512, buffer.length));
			if (head.includes(0)) {
				console.warn(`跳过二进制文件: ${absPath}`);
				return null;
			}

			const content = buffer.toString('utf8');
			const relPath = path
				.relative(this.workspaceRoot, absPath)
				.split(path.sep)
				.join('/');

			return {
				absPath,
				relPath,
				content,
				ext: path.extname(absPath).toLowerCase(),
			};
		} catch {
			return null;
		}
	}

	/**
	 * 解析单个依赖
	 * @returns {string | string[] | null}
	 */
	resolveDependency(fromAbsPath, spec) {
		const fromDir = path.dirname(fromAbsPath);
		const ext = path.extname(fromAbsPath).toLowerCase();

		let cleanSpec = spec.split('?')[0].split('#')[0];

		// ============ Go 特殊处理 ============
		if (ext === '.go') {
			return this.resolveGoDependency(fromAbsPath, cleanSpec);
		}

		// ============ Java/Kotlin 特殊处理 ============
		if (ext === '.java' || ext === '.kt' || ext === '.kts') {
			const suffixes = ext === '.java' ? ['.java'] : ['.kt', '.kts'];
			// 先尝试工作区相对路径
			for (const suffix of suffixes) {
				const p = path.join(this.workspaceRoot, cleanSpec.replace(/\./g, path.sep) + suffix);
				try {
					if (fs.existsSync(p)) return p;
				} catch { /* ignore */ }
			}
			// 再尝试在工作区内按类名搜索
			const searched = this.searchFileByName(
				path.basename(cleanSpec) + (ext === '.java' ? '.java' : '.kt')
			);
			if (searched) return searched;
			return null;
		}

		// ============ 通用路径处理 ============
		if (cleanSpec.startsWith('@/')) {
			cleanSpec = path.join(this.workspaceRoot, cleanSpec.slice(2));
		} else if (cleanSpec.startsWith('/')) {
			cleanSpec = path.join(this.workspaceRoot, cleanSpec.slice(1));
		} else if (cleanSpec.startsWith('.')) {
			cleanSpec = path.join(fromDir, cleanSpec);
		} else {
			return null;
		}

		const candidates = [];
		for (const e of RESOLVE_EXTS) {
			candidates.push(cleanSpec + e);
		}
		for (const e of RESOLVE_EXTS) {
			if (!e) continue;
			candidates.push(path.join(cleanSpec, 'index' + e));
		}

		for (const c of candidates) {
			try {
				if (fs.existsSync(c) && fs.statSync(c).isFile()) {
					return c;
				}
			} catch { /* ignore */ }
		}

		return null;
	}

	/**
	 * 解析 Go 依赖
	 * @param {string} fromAbsPath
	 * @param {string} importPath
	 * @returns {string | string[] | null}
	 */
	resolveGoDependency(fromAbsPath, importPath) {
		// 标准库：没有点号的顶层包名，或含 dart:/package: 之类
		// 标准库一般形如 "fmt"、"net/http"，第一段没有点
		const firstSegment = importPath.split('/')[0];
		if (!firstSegment.includes('.')) {
			// 可能是标准库，也可能是模块内包，需要结合 go.mod 判断
			const mod = this.getGoModule(fromAbsPath);
			if (!mod) return null;

			if (importPath === mod.moduleName) {
				// 导入模块根
				return this.expandGoPackage(mod.goModDir);
			}
			if (importPath.startsWith(mod.moduleName + '/')) {
				const subPath = importPath.slice(mod.moduleName.length + 1);
				const pkgDir = path.join(mod.goModDir, subPath);
				return this.expandGoPackage(pkgDir);
			}
			// 标准库或其它无点号路径，忽略
			return null;
		}

		// 含点号：可能是模块内包（模块名含点）或外部包
		const mod = this.getGoModule(fromAbsPath);
		if (mod) {
			if (importPath === mod.moduleName) {
				return this.expandGoPackage(mod.goModDir);
			}
			if (importPath.startsWith(mod.moduleName + '/')) {
				const subPath = importPath.slice(mod.moduleName.length + 1);
				const pkgDir = path.join(mod.goModDir, subPath);
				return this.expandGoPackage(pkgDir);
			}
		}

		// 外部依赖（github.com/xxx 等），尝试在 go.mod 的 replace 指令里找本地路径
		if (mod) {
			const localPath = this.resolveGoReplace(mod.goModDir, importPath);
			if (localPath) return this.expandGoPackage(localPath);
		}

		return null;
	}

	/**
	 * 展开 Go 包目录下所有 .go 文件（排除 _test.go）
	 * @param {string} pkgDir
	 * @returns {string[] | null}
	 */
	expandGoPackage(pkgDir) {
		try {
			if (!fs.existsSync(pkgDir) || !fs.statSync(pkgDir).isDirectory()) {
				return null;
			}
			const files = fs.readdirSync(pkgDir)
				.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
				.map((f) => path.join(pkgDir, f));
			return files.length > 0 ? files : null;
		} catch {
			return null;
		}
	}

	/**
	 * 解析 go.mod 的 replace 指令，把外部导入映射到本地路径
	 * @param {string} goModDir
	 * @param {string} importPath
	 * @returns {string | null}
	 */
	resolveGoReplace(goModDir, importPath) {
		try {
			const goModPath = path.join(goModDir, 'go.mod');
			if (!fs.existsSync(goModPath)) return null;
			const content = fs.readFileSync(goModPath, 'utf8');
			// replace 指令格式：replace old => new
			const replaceRegex = /^\s*replace\s+(\S+)\s+=>\s+(\S+)/gm;
			let m;
			while ((m = replaceRegex.exec(content)) !== null) {
				const oldPath = m[1];
				const newPath = m[2];
				if (importPath === oldPath) {
					return path.resolve(goModDir, newPath);
				}
				if (importPath.startsWith(oldPath + '/')) {
					const rest = importPath.slice(oldPath.length + 1);
					return path.resolve(goModDir, newPath, rest);
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * 在工作区内按文件名搜索（用于 Java/Kotlin）
	 * @param {string} fileName
	 * @returns {string | null}
	 */
	searchFileByName(fileName) {
		try {
			const result = this._searchFile(this.workspaceRoot, fileName, 0);
			return result;
		} catch {
			return null;
		}
	}

	_searchFile(dir, fileName, depth) {
		if (depth > 10) return null;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name === fileName) {
				return path.join(dir, entry.name);
			}
			if (entry.isDirectory()) {
				if (IGNORE_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith('.')) continue;
				const found = this._searchFile(path.join(dir, entry.name), fileName, depth + 1);
				if (found) return found;
			}
		}
		return null;
	}
}

// ============ 依赖提取 ============
function extractDependencies(ext, content, filePath) {
	switch (ext) {
		case '.js':
		case '.jsx':
		case '.mjs':
		case '.cjs':
		case '.ts':
		case '.tsx':
		case '.mts':
		case '.cts':
			return parseJsTs(content);
		case '.vue':
		case '.svelte':
			return parseVueSvelte(content);
		case '.dart':
			return parseDart(content);
		case '.go':
			return parseGo(content);
		case '.java':
		case '.kt':
		case '.kts':
			return parseJavaKotlin(content);
		default:
			return [];
	}
}

function parseJsTs(content) {
	const deps = [];
	const stripped = content
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');

	const patterns = [
		/import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
		/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
	];
	for (const regex of patterns) {
		let m;
		while ((m = regex.exec(stripped)) !== null) {
			deps.push(m[1]);
		}
	}
	return dedupe(deps);
}

function parseVueSvelte(content) {
	const deps = [];
	const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
	let m;
	while ((m = scriptRegex.exec(content)) !== null) {
		deps.push(...parseJsTs(m[1]));
	}
	return dedupe(deps);
}

function parseDart(content) {
	const deps = [];
	const stripped = content.replace(/\/\/.*$/gm, '');
	const regex = /(?:import|export|part)\s+['"]([^'"]+)['"]/g;
	let m;
	while ((m = regex.exec(stripped)) !== null) {
		const spec = m[1];
		if (spec.startsWith('package:') || spec.startsWith('dart:')) continue;
		deps.push(spec);
	}
	return dedupe(deps);
}

function parseGo(content) {
	const deps = [];
	const stripped = content.replace(/\/\/.*$/gm, '');

	const singleRegex = /import\s+(?:[\w.]+\s+)?"([^"]+)"/g;
	let m;
	while ((m = singleRegex.exec(stripped)) !== null) {
		deps.push(m[1]);
	}

	const blockRegex = /import\s+\(([\s\S]*?)\)/g;
	while ((m = blockRegex.exec(stripped)) !== null) {
		const lineRegex = /(?:[\w.]+\s+)?"([^"]+)"/g;
		let mm;
		while ((mm = lineRegex.exec(m[1])) !== null) {
			deps.push(mm[1]);
		}
	}
	return dedupe(deps);
}

function parseJavaKotlin(content) {
	const deps = [];
	const stripped = content
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');

	const regex = /^\s*import\s+([\w.]+)\s*;?/gm;
	let m;
	while ((m = regex.exec(stripped)) !== null) {
		const fullName = m[1];
		if (fullName.endsWith('.*')) continue;
		deps.push(fullName);
	}
	return dedupe(deps);
}

function dedupe(arr) {
	return [...new Set(arr)];
}

// ============ 输出格式化 ============
function formatOutput(files, workspaceRoot) {
	const treeLines = buildFileTree(files);
	const totalLines = files.reduce((s, f) => s + f.content.split('\n').length, 0);
	const rootName = path.basename(workspaceRoot) + '/';

	const header =
		`=== File tree (${files.length} files, ${totalLines} lines) ===\n` +
		`${rootName}\n` +
		treeLines.join('\n');

	const bodies = files.map(
		(f) => `--- File: ${f.relPath} ---\n\n${f.content}\n`
	);

	return header + '\n\n' + bodies.join('\n\n');
}

function buildFileTree(files) {
	const root = { children: new Map(), isFile: false, path: '' };

	for (const f of files) {
		const parts = f.relPath.split('/');
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isFile = i === parts.length - 1;
			if (!node.children.has(part)) {
				node.children.set(part, {
					children: new Map(),
					isFile,
					path: parts.slice(0, i + 1).join('/'),
				});
			}
			node = node.children.get(part);
		}
	}

	const lines = [];
	const lineMap = new Map(
		files.map((f) => [f.relPath, f.content.split('\n').length])
	);

	function render(node, prefix) {
		const entries = [...node.children.entries()].sort((a, b) => {
			const aIsDir = !a[1].isFile;
			const bIsDir = !b[1].isFile;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return a[0].localeCompare(b[0]);
		});

		entries.forEach(([name, child], idx) => {
			const isLast = idx === entries.length - 1;
			const connector = isLast ? '└── ' : '├── ';
			if (child.isFile) {
				const linesCount = lineMap.get(child.path) || 0;
				lines.push(`${prefix}${connector}${name}  (${linesCount} lines)`);
			} else {
				lines.push(`${prefix}${connector}${name}/`);
				const nextPrefix = prefix + (isLast ? '    ' : '│   ');
				render(child, nextPrefix);
			}
		});
	}

	render(root, '');
	return lines;
}

function formatBytes(bytes) {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

module.exports = { activate, deactivate };