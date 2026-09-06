import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** Reuse the existing browser fixture factories without registering their test suites. */
export function browserFixture(repository, filename, origin) {
  const filenamePath = path.join(repository, "tests", filename);
  const source = fs.readFileSync(filenamePath, "utf8");
  const ast = ts.createSourceFile(filenamePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const moduleUrl = JSON.stringify(pathToFileURL(filenamePath).href);
  const context = vm.createContext({
    URL, Date, Buffer, setTimeout, structuredClone, fileURLToPath,
    process: { env: {} }, join: path.join,
    tmpdir: () => path.join(repository, ".artifacts"),
    readFile: fs.promises.readFile,
  });
  const names = [];
  for (const statement of ast.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    vm.runInContext(statement.getText(ast).replaceAll("import.meta.url", moduleUrl), context);
    names.push(statement.name.text);
  }
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.getText(ast).replaceAll("import.meta.url", moduleUrl)
      .replace(/https?:\/\/127\.0\.0\.1:\d+/g, origin);
    try { vm.runInContext(declaration, context); }
    catch { /* Ignore unrelated test-runner constants; called fixtures must resolve their dependencies. */ }
  }
  return vm.runInContext("({" + names.join(",") + "})", context);
}

