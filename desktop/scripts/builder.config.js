// electron-builder settings for the Windows installers, all built from this one code base.
//   DESK_APP=central -> Riyeser Central (the Riyeser Group home screen)
//   DESK_APP=pdf     -> Riyeser PDF
//   DESK_APP=services -> As Built, formerly Riyeser Services (the riyeser.com/app/ app in its own window)
//   DESK_APP=team    -> Riyeser Link, formerly Riyeser Team (chat, and Link Plus calls: riyeser.com/link in its own window)
//   DESK_APP=linkoffice -> Riyeser Link Office (the office phone system for desk phones)
//   (default)        -> Riyeser Desk Assistant
const base = require('../package.json').build;
const which = ['pdf', 'central', 'services', 'team', 'linkoffice'].includes(process.env.DESK_APP) ? process.env.DESK_APP : 'assistant';
const pdf = which === 'pdf';
const APPS = {
  assistant: { name: 'Riyeser Desk Assistant', appId: 'com.deskassistant.app', ico: 'build/icon.ico', out: 'dist', artifact: 'RiyeserDeskAssistant' },
  pdf: { name: 'Riyeser PDF', appId: 'com.deskassistant.pdf', ico: 'build/pdf/icon.ico', out: 'dist-pdf', artifact: 'RiyeserPDF',
    extraMetadata: { main: 'src/pdf-main.js', name: 'desk-pdf' } },
  central: { name: 'Riyeser Central', appId: 'com.riyeser.central', ico: 'build/central/icon.ico', out: 'dist-central', artifact: 'RiyeserCentral',
    extraMetadata: { main: 'src/central-main.js', name: 'riyeser-central', version: '1.8.1', productName: 'Riyeser Central' } },
  // As Built was called Riyeser Services. Only the name people see changed: the app id, install folder (riyeser-services),
  // program file (Riyeser Services.exe), saved projects and release file (RiyeserServices-Setup.exe) stay the same,
  // so installed copies update in place and keep their projects.
  services: { name: 'As Built', appId: 'com.riyeser.services', ico: 'build/services/icon.ico', out: 'dist-services', artifact: 'RiyeserServices',
    executableName: 'Riyeser Services',
    extraMetadata: { main: 'src/services-main.js', name: 'riyeser-services', version: '1.2.0', productName: 'As Built' } },
  // Riyeser Link was called Riyeser Team. Only the name people see changed (window, tray, shortcuts, Installed apps,
  // Task Manager). The app id, install folder (riyeser-team, from the package name), program file (Riyeser Team.exe),
  // data folder (%APPDATA%\Riyeser Team, set in team-main.js, with the sign-in and chats) and release file
  // (RiyeserTeam-Setup.exe) stay the same, so installed copies update in place and older Centrals still find it.
  team: { name: 'Riyeser Link', appId: 'com.riyeser.team', ico: 'build/team/icon.ico', out: 'dist-team', artifact: 'RiyeserTeam',
    executableName: 'Riyeser Team',
    extraMetadata: { main: 'src/team-main.js', name: 'riyeser-team', version: '1.1.0', productName: 'Riyeser Link' } },
  // Riyeser Link Office installs for the whole PC (one Windows permission prompt) so its installer can add the Windows
  // Firewall rule that lets the office's desk phones reach it (build/link/installer.nsh; removed on uninstall).
  linkoffice: { name: 'Riyeser Link Office', appId: 'com.riyeser.linkoffice', ico: 'build/link/icon.ico', out: 'dist-linkoffice', artifact: 'RiyeserLinkOffice',
    perMachine: true, include: 'build/link/installer.nsh',
    extraMetadata: { main: 'src/link-main.js', name: 'riyeser-linkoffice', version: '1.1.0', productName: 'Riyeser Link Office' } },
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
    oneClick: true,            // one click: installs for this Windows user, no admin needed (Riyeser Link Office: for the whole PC)
    perMachine: !!a.perMachine,
    ...(a.include ? { include: a.include } : {}),
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
