"""Build a Windows .ico the way Windows expects it: BMP images for the small sizes, PNG only for 256x256.
Usage: python3 scripts/make-ico.py <source.png (1024px)> <out.ico>"""
import io, struct, sys
from PIL import Image

SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

def dib(img):
    """32-bit BGRA bitmap (bottom-up) + empty AND mask, as stored inside .ico files."""
    w, h = img.size
    px = img.convert('RGBA').tobytes('raw', 'BGRA')
    rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)][::-1]
    mask_row = b'\0' * (((w + 31) // 32) * 4)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, w * h * 4 + len(mask_row) * h, 0, 0, 0, 0)
    return header + b''.join(rows) + mask_row * h

def main(src, out):
    big = Image.open(src).convert('RGBA')
    images = []
    for s in SIZES:
        im = big.resize((s, s), Image.LANCZOS)
        if s == 256:
            buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True); data = buf.getvalue()
        else:
            data = dib(im)
        images.append((s, data))
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b''; blobs = b''
    for s, data in images:
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    open(out, 'wb').write(head + entries + blobs)
    print(f'{out}: ' + ', '.join(f"{s}px {'PNG' if s == 256 else 'BMP'}" for s, _ in images))

main(*sys.argv[1:3])
