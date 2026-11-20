importScripts('suite/sw-core.js');
suiteWorker({ version: 'alpha-v1', shell: ['./', 'js/main.js', 'js/app-version.js', 'css/app.css'] });
