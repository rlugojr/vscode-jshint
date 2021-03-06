/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection, IConnection, ResponseError, InitializeParams, InitializeResult, InitializeError,
	Diagnostic, DiagnosticSeverity, Files, TextDocuments, ITextDocument, ErrorMessageTracker, IPCMessageReader, IPCMessageWriter
} from 'vscode-languageserver';

import fs = require('fs');
import path = require('path');

import * as minimatch from 'minimatch';
import * as _ from 'lodash';

import processIgnoreFile = require('parse-gitignore');


interface JSHintOptions {
	config?: string
	[key: string]: any;
}

interface FileSettings {
	[pattern: string]: boolean;
}

interface JSHintSettings {
	enable: boolean;
	config?: string;
	options: JSHintOptions;
	excludePath?: string;
	exclude: FileSettings;
}

interface Settings {
	jshint: JSHintSettings;
	[key: string]: any;
}

interface JSHintError {
	id: string;
	raw: string;
	code: string;
	line: number;
	character: number;
	scope: string;
	reason: string;
}

interface JSHintUnused {
	name: string;
	line: number;
	character: number;
}

interface JSHintReport {
	options: any;
	errors: JSHintError[];
	unused: JSHintUnused[];
}

interface PackageJSHintConfig {
	jshintConfig: any;
}

interface JSHINT {
	(content: string, options: any, globals: any): void;
	errors: JSHintError[];
}

function makeDiagnostic(problem: JSHintError): Diagnostic {
	// Setting errors (and potentially global file errors) will report on line zero, char zero.
	// Ensure that the start and end are >=0 (gets dropped by one in the return)
	if (problem.line <= 0) {
		problem.line = 1;
	}
	if (problem.character <= 0) {
		problem.character = 1;
	}
	return {
		message: problem.reason + (problem.code ? ` (${problem.code})` : ''),
		severity: getSeverity(problem),
		source: 'jshint',
		code: problem.code,
		range: {
			start: { line: problem.line - 1, character: problem.character - 1 },
			end: { line: problem.line - 1, character: problem.character - 1 }
		}
	};
}

function getSeverity(problem: JSHintError): number {
	// If there is no code (that would be very odd) we'll push it as an error as well.
	// See http://jshint.com/docs/ (search for error. It is only mentioned once.)
	if (!problem.code || problem.code[0] === 'E') {
		return DiagnosticSeverity.Error;
	}
	return DiagnosticSeverity.Warning;
}

function locateFile(directory: string, fileName: string) {
	let parent = directory;
	do {
		directory = parent;
		let location = path.join(directory, fileName);
		if (fs.existsSync(location)) {
			return location;
		}
		parent = path.dirname(directory);
	} while (parent !== directory);
	return undefined;
};

const JSHINTRC = '.jshintrc';
class OptionsResolver {

	private connection: IConnection;
	private configPath: string;
	private jshintOptions: JSHintOptions;
	private optionsCache: { [key: string]: any };

	constructor(connection: IConnection) {
		this.connection = connection;
		this.clear();
		this.configPath = null;
		this.jshintOptions = null;
	}

	public configure(path: string, jshintOptions?: JSHintOptions) {
		this.optionsCache = Object.create(null);
		this.configPath = path;
		this.jshintOptions = jshintOptions;
	}

	public clear(jshintOptions?: JSHintOptions) {
		this.optionsCache = Object.create(null);
	}

	public getOptions(fsPath: string): any {
		let result = this.optionsCache[fsPath];
		if (!result) {
			result = this.readOptions(fsPath);
			this.optionsCache[fsPath] = result;
		}
		return result;
	}

	private readOptions(fsPath: string = null): any {
		let that = this;

		function stripComments(content: string): string {
			/**
			* First capturing group matches double quoted string
			* Second matches single quotes string
			* Third matches block comments
			* Fourth matches line comments
			*/
			var regexp: RegExp = /("(?:[^\\\"]*(?:\\.)?)*")|('(?:[^\\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g;
			let result = content.replace(regexp, (match, m1, m2, m3, m4) => {
				// Only one of m1, m2, m3, m4 matches
				if (m3) {
					// A block comment. Replace with nothing
					return "";
				} else if (m4) {
					// A line comment. If it ends in \r?\n then keep it.
					let length = m4.length;
					if (length > 2 && m4[length - 1] === '\n') {
						return m4[length - 2] === '\r' ? '\r\n' : '\n';
					} else {
						return "";
					}
				} else {
					// We match a string
					return match;
				}
			});
			return result;
		};

		function readJsonFile(file: string, extendedFrom?: string): any {
			try {
				return JSON.parse(stripComments(fs.readFileSync(file).toString()));
			}
			catch (err) {
				let location = extendedFrom ? `${file} extended from ${extendedFrom}` : file;
				that.connection.window.showErrorMessage(`Can't load JSHint configuration from file ${location}. Please check the file for syntax errors.`);
				return {};
			}
		}

		function readJSHintFile(file: string, extendedFrom?: string): any {
			let content = readJsonFile(file, extendedFrom);
			if (content.extends) {
				let baseFile = path.resolve(path.dirname(file), content.extends);

				if (fs.existsSync(baseFile)) {
					content = _.mergeWith(readJSHintFile(baseFile, file), content, (baseValue, contentValue) => {
						if (_.isArray(baseValue)) {
							return baseValue.concat(contentValue);
						}
					});
				} else {
					that.connection.window.showErrorMessage(`Can't find JSHint file ${baseFile} extended from ${file}`);
				}

				delete content.extends;
			}
			return content;
		}

		function isWindows(): boolean {
			return process.platform === 'win32';
		}

		function getUserHome() {
			return process.env[isWindows() ? 'USERPROFILE' : 'HOME'];
		}

		if (this.configPath && fs.existsSync(this.configPath)) {
			return readJsonFile(this.configPath);
		}

		let jshintOptions = this.jshintOptions;
		// backward compatibility
		if (jshintOptions && jshintOptions.config && fs.existsSync(jshintOptions.config)) {
			return readJsonFile(jshintOptions.config);
		}

		if (fsPath) {
			let packageFile = locateFile(fsPath, 'package.json');
			if (packageFile) {
				let content = readJsonFile(packageFile);
				if (content.jshintConfig) {
					return content.jshintConfig;
				}
			}

			let configFile = locateFile(fsPath, JSHINTRC);
			if (configFile) {
				return readJSHintFile(configFile);
			}
		}

		let home = getUserHome();
		if (home) {
			let file = path.join(home, JSHINTRC);
			if (fs.existsSync(file)) {
				return readJSHintFile(file);
			}
		}
		return jshintOptions;
	}
}

const JSHINTIGNORE = '.jshintignore';
class FileMatcher {
	private configPath: string;
	private defaultExcludePatterns: string[];
	private excludeCache: { [key: string]: any };

	constructor() {
		this.configPath = null;
		this.defaultExcludePatterns = null;
		this.excludeCache = {};
	}

	private pickTrueKeys(obj: FileSettings) {
		return _.keys(_.pickBy(obj, (value) => {
			return value === true;
		}));
	}

	public configure(path: string, exclude?: FileSettings): void {
		this.configPath = path;
		this.excludeCache = {};
		this.defaultExcludePatterns = this.pickTrueKeys(exclude);
	}

	public clear(exclude?: FileSettings): void {
		this.excludeCache = {};
	}

	private relativeTo(fsPath: string, folder: string): string {
		if (folder && 0 === fsPath.indexOf(folder)) {
			let cuttingPoint = folder.length;
			if (cuttingPoint < fsPath.length && '/' === fsPath.charAt(cuttingPoint)) {
				cuttingPoint += 1;
			}
			return fsPath.substr(cuttingPoint);
		}
		return fsPath;
	}

	private folderOf(fsPath: string): string {
		let index = fsPath.lastIndexOf('/');
		return index > -1 ? fsPath.substr(0, index) : fsPath;
	}

	private match(excludePatters: string[], path: string, root: string): boolean {
		let relativePath = this.relativeTo(path, root);
		return _.some(excludePatters, (pattern) => {
			return minimatch(relativePath, pattern);
		});
	};

	public excludes(fsPath: string, root: string): boolean {
		if (fsPath) {

			if (this.excludeCache.hasOwnProperty(fsPath)) {
				return this.excludeCache[fsPath];
			}

			let shouldBeExcluded = false;

			if (this.configPath && fs.existsSync(this.configPath)) {
				shouldBeExcluded = this.match(processIgnoreFile(this.configPath), fsPath, root);
			} else {
				let ignoreFile = locateFile(fsPath, JSHINTIGNORE);
				if (ignoreFile) {
					shouldBeExcluded = this.match(processIgnoreFile(ignoreFile), fsPath, this.folderOf(ignoreFile));
				} else {
					shouldBeExcluded = this.match(this.defaultExcludePatterns, fsPath, root);
				}
			}

			this.excludeCache[fsPath] = shouldBeExcluded;
			return shouldBeExcluded;
		}

		return true;
	}
}

class Linter {
	private connection: IConnection;
	private options: OptionsResolver;
	private fileMatcher: FileMatcher;
	private documents: TextDocuments;

	private workspaceRoot: string;
	private lib: any;

	constructor() {
		this.connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
		this.options = new OptionsResolver(this.connection);
		this.fileMatcher = new FileMatcher();
		this.documents = new TextDocuments();
		this.documents.onDidChangeContent(event => this.validateSingle(event.document));
		this.documents.onDidClose((event) => {
			this.connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
			console.log('did sent');
		});
		this.documents.listen(this.connection);

		this.connection.onInitialize(params => this.onInitialize(params));
		this.connection.onDidChangeConfiguration(params => {
			let jshintSettings = _.assign<Object, JSHintSettings>({ options: {}, exclude: {} }, (<Settings>params.settings).jshint);
			this.options.configure(jshintSettings.config, jshintSettings.options);
			this.fileMatcher.configure(jshintSettings.excludePath, jshintSettings.exclude);
			this.validateAll();
		});
		this.connection.onDidChangeWatchedFiles(params => {
			var needsValidating = false;
			if (params.changes) {
				params.changes.forEach(change => {
					switch (this.lastSegment(change.uri)) {
						case JSHINTRC:
							this.options.clear();
							needsValidating = true;
							break;
						case JSHINTIGNORE:
							this.fileMatcher.clear();
							needsValidating = true;
							break;
					}
				});
			}
			if (needsValidating) {
				this.validateAll();
			}
		});
	}

	public listen(): void {
		this.connection.listen();
	}

	private lastSegment(fsPath: string): string {
		let index = fsPath.lastIndexOf('/');
		return index > -1 ? fsPath.substr(index + 1) : fsPath;
	}

	private onInitialize(params: InitializeParams): Thenable<InitializeResult | ResponseError<InitializeError>> {
		this.workspaceRoot = params.rootPath;
		return Files.resolveModule(this.workspaceRoot, 'jshint').then((value) => {
			if (!value.JSHINT) {
				return new ResponseError(99, 'The jshint library doesn\'t export a JSHINT property.', { retry: false });
			}
			this.lib = value;
			let result: InitializeResult = { capabilities: { textDocumentSync: this.documents.syncKind } };
			return result;
		}, (error) => {
			return Promise.reject(
				new ResponseError<InitializeError>(99,
					'Failed to load jshint library. Please install jshint in your workspace folder using \'npm install jshint\' or globally using \'npm install -g jshint\' and then press Retry.',
					{ retry: true }));
		});
	}

	private validateAll(): void {
		let tracker = new ErrorMessageTracker();
		this.documents.all().forEach(document => {
			try {
				this.validate(document);
			} catch (err) {
				tracker.add(this.getMessage(err, document));
			}
		});
		tracker.sendErrors(this.connection);
	}

	private validateSingle(document: ITextDocument): void {
		try {
			this.validate(document);
		} catch (err) {
			this.connection.window.showErrorMessage(this.getMessage(err, document));
		}
	}


	private lintContent(content: string, fsPath: string): JSHintError[] {
		let JSHINT: JSHINT = this.lib.JSHINT;
		let options = this.options.getOptions(fsPath) || {};
		JSHINT(content, options, options.globals || {});
		return JSHINT.errors;
	}


	private validate(document: ITextDocument) {

		let fsPath = Files.uriToFilePath(document.uri);
		if (!fsPath) {
			fsPath = this.workspaceRoot;
		}

		let diagnostics: Diagnostic[] = [];

		if (!this.fileMatcher.excludes(fsPath, this.workspaceRoot)) {
			let errors = this.lintContent(document.getText(), fsPath);
			if (errors) {
				errors.forEach((error) => {
					// For some reason the errors array contains null.
					if (error) {
						diagnostics.push(makeDiagnostic(error));
					}
				});
			}
		}
		this.connection.sendDiagnostics({ uri: document.uri, diagnostics });
	}

	private getMessage(err: any, document: ITextDocument): string {
		let result: string = null;
		if (typeof err.message === 'string' || err.message instanceof String) {
			result = <string>err.message;
		} else {
			result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
		}
		return result;
	}
}

new Linter().listen();