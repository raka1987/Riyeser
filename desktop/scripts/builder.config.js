// electron-builder settings for the Windows installers, all built from this one code base.
//   DESK_APP=central -> Riyeser Central (the Riyeser Group home screen)
//   DESK_APP=pdf     -> Riyeser PDF
//   DESK_APP=services -> As Built, formerly Riyeser Services (the riyeser.com/app/ app in its own window)
//   DESK_APP=team    -> Riyeser Team (team chat and Team Chat Plus calls, riyeser.com/team in its own window)
//   (default)        -> Riyeser Desk Assistant
const base = require('../package.json').build;
const which = ['pdf', 'central', 'services', 'team'].includes(process.env.DESK_APP) ? process.env.DESK_APP : 'assistant';
const pdf = which === 'pdf';
const APPS = {
  assistant: { name: 'Riyeser Desk Assistant', appId: 'com.deskassistant.app', ico: 'build/icon.ico', out: 'dist', artifact: 'RiyeserDeskAssistant' },
  pdf: { name: 'Riyeser PDF', appId: 'com.deskassistant.pdf', ico: 'build/pdf/icon.ico', out: 'dist-pdf', artifact: 'RiyeserPDF',
    extraMetadata: { main: 'src/pdf-main.js', name: 'desk-pdf' } },
  central: { name: 'Riyeser Central', appId: 'com.riyeser.central', ico: 'build/central/icon.ico', out: 'dist-central', artifact: 'RiyeserCentral',
    extraMetadata: { main: 'src/central-main.js', name: 'riyeser-central', version: '1.7.0', productName: 'Riyeser Central' } },
  // As Built was called Riyeser Services. Only the name people see changed: the app id, install folder (riyeser-services),
  // program file (Riyeser Services.exe), saved projects and release file (RiyeserServices-Setup.exe) stay the same,
  // so installed copies update in place and keep their projects.
  services: { name: 'As Built', appId: 'com.riyeser.services', ico: 'build/services/icon.ico', out: 'dist-services', artifact: 'RiyeserServices',
    executableName: 'Riyeser Services',
    extraMetadata: { main: 'src/services-main.js', name: 'riyeser-services', version: '1.2.0', productName: 'As Built' } },
  team: { name: 'Riyeser Team', appId: 'com.riyeser.team', ico: 'build/team/icon.ico', out: 'dist-team', artifact: 'RiyeserTeam',
    extraMetadata: { main: 'src/team-main.js', name: 'riyeser-team', version: '1.0.0', productName: 'Riyeser Team' } },
};
const a = APPS[which];

module.exports = {
  ...base,
  productName: a.name,
  appId: a.appId,
  ...(a.executableName ? { executableName: a.executableName } : {}),
  ...(a.extraMetadata ? { extraMetadata: a.extraMetadata } : {}),
  directories: { ...base.directories, output: a.out },
  // Riyeser PDF offers itself for .pdf files ("Open with", Default apps)
  ...(pdf ? { fileAssociations: [{ ext: 'pdf', name: 'PDF Document', description: 'PDF document', icon: a.ico, role: 'Editor' }] } : {}),
  // Riyeser Central reads Accounting's books with sql.js (WebAssembly), kept outside the archive.
  // As Built carries its own copy of the app (built by package-win.js into build/services-web).
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
