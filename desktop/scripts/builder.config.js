// electron-builder settings for the Windows installers, all built from this one code base.
//   DESK_APP=central -> Riyeser Central (the Riyeser Group home screen)
//   DESK_APP=pdf     -> Riyeser PDF
//   DESK_APP=services -> Riyeser Services (the riyeser.com/app/ app in its own window)
//   (default)        -> Riyeser Desk Assistant
const base = require('../package.json').build;
const which = ['pdf', 'central', 'services'].includes(process.env.DESK_APP) ? process.env.DESK_APP : 'assistant';
const pdf = which === 'pdf';
const APPS = {
  assistant: { name: 'Riyeser Desk Assistant', appId: 'com.deskassistant.app', ico: 'build/icon.ico', out: 'dist', artifact: 'RiyeserDeskAssistant' },
  pdf: { name: 'Riyeser PDF', appId: 'com.deskassistant.pdf', ico: 'build/pdf/icon.ico', out: 'dist-pdf', artifact: 'RiyeserPDF',
    extraMetadata: { main: 'src/pdf-main.js', name: 'desk-pdf' } },
  central: { name: 'Riyeser Central', appId: 'com.riyeser.central', ico: 'build/central/icon.ico', out: 'dist-central', artifact: 'RiyeserCentral',
    extraMetadata: { main: 'src/central-main.js', name: 'riyeser-central', version: '1.3.5', productName: 'Riyeser Central' } },
  services: { name: 'Riyeser Services', appId: 'com.riyeser.services', ico: 'build/services/icon.ico', out: 'dist-services', artifact: 'RiyeserServices',
    extraMetadata: { main: 'src/services-main.js', name: 'riyeser-services', version: '1.1.1', productName: 'Riyeser Services' } },
};
const a = APPS[which];

module.exports = {
  ...base,
  productName: a.name,
  appId: a.appId,
  ...(a.extraMetadata ? { extraMetadata: a.extraMetadata } : {}),
  directories: { ...base.directories, output: a.out },
  // Riyeser PDF offers itself for .pdf files ("Open with", Default apps)
  ...(pdf ? { fileAssociations: [{ ext: 'pdf', name: 'PDF Document', description: 'PDF document', icon: a.ico, role: 'Editor' }] } : {}),
  // Riyeser Central reads Accounting's books with sql.js (WebAssembly), kept outside the archive.
  // Riyeser Services carries its own copy of the app (built by package-win.js into build/services-web).
  ...(which === 'services' ? { extraResources: [{ from: 'build/services-web', to: 'services-web' }] } : {}),
  ...(which === 'central' ? { asarUnpack: [...(base.asarUnpack || []), 'node_modules/sql.js/dist/**'] } : {}),
  copyright: 'Riyeser Group',
  publish: null,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: a.ico, legalTrademarks: a.name },
  nsis: {
    oneClick: true,            // one click: installs for this Windows user, no admin needed
    perMachine: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: a.name,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // keep settings unless the user removes them in the app
    installerIcon: a.ico,
    uninstallerIcon: a.ico,
    uninstallDisplayName: `${a.name} \${version}`,
    artifactName: `${a.artifact}-Setup-\${version}.\${ext}`,
  },
};
