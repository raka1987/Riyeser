// electron-builder settings for the Windows installers. DESK_APP=pdf builds Desk PDF, otherwise Desk Assistant.
const base = require('../package.json').build;
const pdf = process.env.DESK_APP === 'pdf';
const name = pdf ? 'Desk PDF' : 'Riyeser Desk Assistant';
const ico = pdf ? 'build/pdf/icon.ico' : 'build/icon.ico';

module.exports = {
  ...base,
  productName: name,
  appId: pdf ? 'com.deskassistant.pdf' : 'com.deskassistant.app',
  ...(pdf ? { extraMetadata: { main: 'src/pdf-main.js', name: 'desk-pdf' } } : {}),
  directories: { ...base.directories, output: pdf ? 'dist-pdf' : 'dist' },
  // Desk PDF offers itself for .pdf files ("Open with", Default apps)
  ...(pdf ? { fileAssociations: [{ ext: 'pdf', name: 'PDF Document', description: 'PDF document', icon: ico, role: 'Editor' }] } : {}),
  // Riyeser Accounting runs inside the app with its own private Python (prepared by scripts/prepare_python.py).
  ...(pdf ? {} : { extraResources: [{ from: 'build/python-win', to: 'python' }, { from: 'build/accounting', to: 'accounting' }] }),
  copyright: 'Riyeser Group',
  publish: null,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: ico, legalTrademarks: name },
  nsis: {
    oneClick: true,            // one click: installs for this Windows user, no admin needed
    perMachine: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: name,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // keep signatures/settings unless the user removes them in the app
    installerIcon: ico,
    uninstallerIcon: ico,
    uninstallDisplayName: `${name} \${version}`,
    artifactName: `${pdf ? 'DeskPDF' : 'RiyeserDeskAssistant'}-Setup-\${version}.\${ext}`,
  },
};
