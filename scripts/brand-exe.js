// Puts our icon and name on the Windows .exe (instead of Electron's), without needing Windows to build.
// Usage: node scripts/brand-exe.js <path to .exe> <icon.ico> "<Product name>" "<Description>" <version>
const fs = require('fs');
const ResEdit = require('resedit');
const PE = require('pe-library');

const [exePath, icoPath, productName, description, version] = process.argv.slice(2);
if (!exePath || !icoPath) { console.error('usage: brand-exe <exe> <ico> <name> <description> <version>'); process.exit(1); }

const exe = PE.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PE.NtExecutableResource.from(exe);

// icon
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const target = groups[0] || { id: 1, lang: 1033 };
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));

// name shown in Task Manager / file properties
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  const [a, b, c] = String(version || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const lang = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  vi.setStringValues(lang, {
    ProductName: productName, FileDescription: description || productName, CompanyName: productName,
    InternalName: productName, OriginalFilename: require('path').basename(exePath), LegalCopyright: '',
    FileVersion: version, ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Branded ${exePath}`);
