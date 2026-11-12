const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

async function main() {
  // Ensure dist directories exist
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'dist', 'test'), { recursive: true });

  // Copy webview static files
  const copyWebviewAssets = () => {
    const srcDir = path.join(__dirname, 'src', 'webview', 'ui');
    const targetDir = path.join(__dirname, 'dist', 'webview');
    ['index.html', 'styles.css'].forEach(file => {
      const srcFile = path.join(srcDir, file);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(targetDir, file));
      }
    });
  };

  copyWebviewAssets();

  // Extension host bundle
  const extensionContext = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });

  // Webview client bundle
  const webviewContext = await esbuild.context({
    entryPoints: ['src/webview/ui/app.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/webview/app.js',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });

  // Tests bundle
  const testFiles = fs.readdirSync(path.join(__dirname, 'src', 'test')).filter(f => f.endsWith('.ts'));
  const testContext = testFiles.length > 0 ? await esbuild.context({
    entryPoints: testFiles.map(f => path.join('src', 'test', f)),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outdir: 'dist/test',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  }) : null;

  if (isWatch) {
    await extensionContext.watch();
    await webviewContext.watch();
    if (testContext) await testContext.watch();
    fs.watch(path.join(__dirname, 'src', 'webview', 'ui'), (event, filename) => {
      if (filename === 'index.html' || filename === 'styles.css') {
        copyWebviewAssets();
      }
    });
    console.log('Watching for changes...');
  } else {
    await extensionContext.rebuild();
    await extensionContext.dispose();

    await webviewContext.rebuild();
    await webviewContext.dispose();

    if (testContext) {
      await testContext.rebuild();
      await testContext.dispose();
    }
    copyWebviewAssets();
    console.log('Build completed successfully.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
