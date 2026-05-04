import struct
import zlib


def create_png(size, bg_color=(26, 115, 232), fg_color=(255, 255, 255)):
    pixels = []
    center = size / 2
    radius = size / 2
    for y in range(size):
        row = [0]
        for x in range(size):
            dx = x - center + 0.5
            dy = y - center + 0.5
            dist = (dx * dx + dy * dy) ** 0.5
            if dist <= radius:
                in_t = False
                rel_x = (x - center) / radius
                rel_y = (y - center) / radius
                if -0.5 <= rel_x <= 0.5 and -0.45 <= rel_y <= -0.15:
                    in_t = True
                if -0.15 <= rel_x <= 0.15 and -0.15 <= rel_y <= 0.55:
                    in_t = True
                if in_t:
                    row.extend(list(fg_color) + [255])
                else:
                    row.extend(list(bg_color) + [255])
            else:
                row.extend([0, 0, 0, 0])
        pixels.append(bytes(row))
    raw = b''.join(pixels)

    def chunk(ctype, data):
        c = ctype + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack('>I', len(data)) + c + crc

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    compressed = zlib.compress(raw)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')


for s in [16, 48, 128]:
    data = create_png(s)
    path = f'e:/Chrome_translate/icons/icon{s}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path} ({len(data)} bytes)')
