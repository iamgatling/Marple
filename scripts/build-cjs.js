import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function buildCjsDir(srcDir, outDir) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const outPath = path.join(outDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'cjs') continue;
      buildCjsDir(srcPath, outPath);
    } else if (entry.name.endsWith('.js')) {
      const code = fs.readFileSync(srcPath, 'utf8');
      let out = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        }
      }).outputText;

      out = out.replace(/const __filename = [^;]+;/g, '');
      out = out.replace(/const __dirname = [^;]+;/g, '');
      out = out.replace(/const require = [^;]+;/g, '');

      if (entry.name === 'index.js' && srcDir.endsWith('dist')) {
        out += '\nmodule.exports = exports.default || exports;\nObject.assign(module.exports, exports);\n';
      }
      if (entry.name === 'client.js' && srcDir.endsWith('dist')) {
        out += '\nmodule.exports = exports.default || exports;\nObject.assign(module.exports, exports);\n';
      }

      fs.writeFileSync(outPath, out, 'utf8');
    } else if (entry.name.endsWith('.html')) {
      fs.copyFileSync(srcPath, outPath);
    }
  }
}

const distDir = path.resolve('dist');
const cjsDir = path.resolve('dist/cjs');

buildCjsDir(distDir, cjsDir);

fs.writeFileSync(
  path.join(cjsDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2),
  'utf8'
);
