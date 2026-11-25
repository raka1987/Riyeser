// S46: fonts for text Riyeser PDF adds in any language. The standard PDF fonts only have Western European letters
// ("Mary Nguyễn" couldn't be saved), so text that needs more is written with a font from the PC itself, chosen by the
// kind of letters: 'latin' (Vietnamese, Fijian ā, Māori, Polish…), 'devanagari' (Hindi) or 'cjk' (Chinese and
// Japanese). Only the letters used are put into the PDF.
const fs = require('fs');
const path = require('path');

/** The font files to try for each kind of text, most suitable first. */
function candidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const d = path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts');
    const f = (...names) => names.map((n) => path.join(d, n));
    return {
      latin: f('segoeui.ttf', 'arial.ttf', 'calibri.ttf', 'tahoma.ttf'),
      devanagari: f('Nirmala.ttf', 'NirmalaUI.ttf', 'Nirmala.ttc', 'mangal.ttf', 'aparaj.ttf'),
      cjk: f('Deng.ttf', 'simhei.ttf', 'msyh.ttf', 'msyh.ttc', 'simsun.ttc', 'msjh.ttc', 'meiryo.ttc', 'YuGothR.ttc', 'malgun.ttf'),
    };
  }
  if (platform === 'darwin') {
    const s = '/System/Library/Fonts'; const sup = '/System/Library/Fonts/Supplemental'; const lib = '/Library/Fonts';
    return {
      latin: [path.join(sup, 'Arial Unicode.ttf'), path.join(sup, 'Arial.ttf'), path.join(s, 'Helvetica.ttc')],
      devanagari: [path.join(sup, 'Devanagari Sangam MN.ttc'), path.join(s, 'Kohinoor.ttc'), path.join(sup, 'Arial Unicode.ttf')],
      cjk: [path.join(s, 'PingFang.ttc'), path.join(s, 'STHeiti Light.ttc'), path.join(sup, 'Arial Unicode.ttf'), path.join(lib, 'Arial Unicode.ttf')],
    };
  }
  const u = '/usr/share/fonts';
  return {
    latin: [`${u}/truetype/dejavu/DejaVuSans.ttf`, `${u}/truetype/noto/NotoSans-Regular.ttf`, `${u}/truetype/freefont/FreeSans.ttf`, `${u}/truetype/liberation/LiberationSans-Regular.ttf`],
    devanagari: [`${u}/truetype/noto/NotoSansDevanagari-Regular.ttf`, `${u}/truetype/freefont/FreeSans.ttf`, `${u}/truetype/lohit-devanagari/Lohit-Devanagari.ttf`],
    cjk: [`${u}/opentype/noto/NotoSansCJK-Regular.ttc`, `${u}/truetype/wqy/wqy-microhei.ttc`, `${u}/truetype/droid/DroidSansFallbackFull.ttf`, `${u}/opentype/unifont/unifont.otf`, `${u}/opentype/unifont/unifont_jp.otf`],
  };
}

/** The bytes of the first font for that kind of text found on this PC, or null. { file, bytes } */
function findFont(script, opts = {}) {
  const list = candidates(opts.platform, opts.env)[script] || [];
  for (const file of list) {
    try { if (fs.statSync(file).isFile()) return { file, bytes: fs.readFileSync(file) }; } catch { /* not on this PC */ }
  }
  return null;
}

module.exports = { candidates, findFont };
