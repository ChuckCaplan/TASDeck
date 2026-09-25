#!/usr/bin/env python3
"""Build a homebrew receiver probe and matching R08. Requires ca65/ld65 only."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

# Original 5x7 bitmap glyphs; one ASCII-indexed NES tile per character.
FONT = {
    ' ': '00000/00000/00000/00000/00000/00000/00000',
    '-': '00000/00000/00000/11111/00000/00000/00000',
    '0': '01110/10001/10011/10101/11001/10001/01110',
    '1': '00100/01100/00100/00100/00100/00100/01110',
    '2': '01110/10001/00001/00010/00100/01000/11111',
    '3': '11110/00001/00001/01110/00001/00001/11110',
    '4': '00010/00110/01010/10010/11111/00010/00010',
    '5': '11111/10000/10000/11110/00001/00001/11110',
    '6': '01110/10000/10000/11110/10001/10001/01110',
    '7': '11111/00001/00010/00100/01000/01000/01000',
    '8': '01110/10001/10001/01110/10001/10001/01110',
    '9': '01110/10001/10001/01111/00001/00001/01110',
    'A': '01110/10001/10001/11111/10001/10001/10001',
    'B': '11110/10001/10001/11110/10001/10001/11110',
    'C': '01111/10000/10000/10000/10000/10000/01111',
    'D': '11110/10001/10001/10001/10001/10001/11110',
    'E': '11111/10000/10000/11110/10000/10000/11111',
    'F': '11111/10000/10000/11110/10000/10000/10000',
    'G': '01111/10000/10000/10111/10001/10001/01111',
    'H': '10001/10001/10001/11111/10001/10001/10001',
    'I': '01110/00100/00100/00100/00100/00100/01110',
    'J': '00111/00010/00010/00010/10010/10010/01100',
    'K': '10001/10010/10100/11000/10100/10010/10001',
    'L': '10000/10000/10000/10000/10000/10000/11111',
    'M': '10001/11011/10101/10101/10001/10001/10001',
    'N': '10001/11001/11001/10101/10011/10011/10001',
    'O': '01110/10001/10001/10001/10001/10001/01110',
    'P': '11110/10001/10001/11110/10000/10000/10000',
    'Q': '01110/10001/10001/10001/10101/10010/01101',
    'R': '11110/10001/10001/11110/10100/10010/10001',
    'S': '01111/10000/10000/01110/00001/00001/11110',
    'T': '11111/00100/00100/00100/00100/00100/00100',
    'U': '10001/10001/10001/10001/10001/10001/01110',
    'V': '10001/10001/10001/10001/10001/01010/00100',
    'W': '10001/10001/10001/10101/10101/11011/10001',
    'X': '10001/10001/01010/00100/01010/10001/10001',
    'Y': '10001/10001/01010/00100/00100/00100/00100',
    'Z': '11111/00001/00010/00100/01000/10000/11111',
}


def patterns():
    # Four-record signature followed by 8192 changing two-port records.
    result = bytearray.fromhex('A5 5A 3C C3 96 69 0F F0')
    lfsr = 0xACE1
    for i in range(8192):
        if i % 64 < 16:
            a = 1 << (i % 8)
            if i % 64 >= 8:
                a ^= 255
            b = a ^ 255
        elif i % 64 < 20:
            a, b = ((0x55, 0xAA) if i % 2 else (0xAA, 0x55))
        else:
            lfsr = (lfsr >> 1) ^ (0xB400 if lfsr & 1 else 0)
            a, b = lfsr & 255, lfsr >> 8
        result.extend((a, b))
    return bytes(result)


def build(output):
    source = Path(__file__).resolve().parent
    output.mkdir(parents=True, exist_ok=True)
    expected = patterns()
    with tempfile.TemporaryDirectory(prefix='tasdeck-input-') as temp:
        work = Path(temp)
        (work / 'expected.bin').write_bytes(expected)
        subprocess.run(['ca65', str(source / 'probe.s'), '--bin-include-dir', str(work),
                        '-o', str(work / 'probe.o')], check=True)
        subprocess.run(['ld65', '-C', str(source / 'probe.cfg'),
                        str(work / 'probe.o'), '-o', str(work / 'probe.prg')], check=True)
        prg = (work / 'probe.prg').read_bytes()
    # Assert the complete timing-critical loop including branch displacement.
    loop = bytes.fromhex('A2018E1640CA8E1640A208AD16406A2615AD17406A2616CAD0F1')
    if prg[0xD78:0xD78 + len(loop)] != loop:
        raise RuntimeError('Controller-read instruction bytes changed')
    if prg[0x2000:0x2000 + len(expected)] != expected:
        raise RuntimeError('Expected input table moved or changed')
    chr_rom = bytearray(8192)
    for char, rows in FONT.items():
        tile = bytes([int(row, 2) << 2 for row in rows.split('/')] + [0])
        chr_rom[ord(char) * 16:ord(char) * 16 + 8] = tile
    rom = b'NES\x1a\x02\x01' + bytes(10) + prg + chr_rom
    files = {
        'Battletoads input test.nes': rom,
        'battletoads_input_test.r08': bytes(128) + expected,
    }
    for name, content in files.items():
        (output / name).write_bytes(content)
    manifest = {
        'purpose': 'NES-side input delivery diagnostic, not a patched game',
        'checked_records': len(expected) // 2,
        'leading_blank_records': 64,
        'total_r08_records': 64 + len(expected) // 2,
        'expected_pass_index_hex': '2004',
        'settings': {'ports': 2, 'sync_mode': 'strobe', 'delay': 1, 'skip': 0},
        'sha256': {n: hashlib.sha256(b).hexdigest() for n, b in files.items()},
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
