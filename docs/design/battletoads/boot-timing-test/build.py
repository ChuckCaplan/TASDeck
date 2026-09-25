#!/usr/bin/env python3
"""Build the TASDeck boot-timing test ROM and a matching blank .r08. Requires ca65/ld65.

The ROM performs Battletoads-style two-port controller reads at exact CPU-cycle intervals (rendering
and interrupts off, cycle-counted delays), then shows those intervals on screen in the same units as
TASDeck's `Boot timing` log line. The default schedule is the latch timing of Battletoads' game-end
glitch on the NesHawk power-on state Alyosha dumped it with, so the log line of a correct capture
looks like a winning Battletoads boot.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

# Latch-to-latch gaps in CPU cycles: the game's first 19 polls on NesHawk's default power-on state.
SCHEDULE = [386985, 328925, 415412, 285769, 29540, 29846, 29897, 30292, 29543, 29846, 29898,
            30287, 29546, 29840, 29903, 30290, 29543, 29844, 29900]
CYCLES_PER_FRAME = 29780.5
# From one read's rising strobe edge to the next block's: the rest of the read (223 cycles), the
# JMP to the next block (3) and that block's LDX #1 / STX $4016 up to its write cycle (6).
READ_OVERHEAD = 232

FONT = {
    ' ': '00000/00000/00000/00000/00000/00000/00000',
    '-': '00000/00000/00000/11111/00000/00000/00000',
    '.': '00000/00000/00000/00000/00000/01100/01100',
    ':': '00000/01100/01100/00000/01100/01100/00000',
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


def delay_code(cycles):
    """Straight-line ca65 code that takes exactly `cycles` CPU cycles (no page-crossing branches
    as long as the block stays inside one page)."""
    lines, left, n = [], cycles, 0

    def label():
        nonlocal n
        n += 1
        return f'@d{n}'
    # Outer groups: LDX #a / LDY #0 / DEY / BNE / DEX / BNE costs a*1286 + 1.
    while left >= 1286 + 1 + 1300:
        a = min(255, (left - 1300) // 1286)
        l1, l2 = label(), label()
        lines += [f'  ldx #{a}', f'{l1}:', '  ldy #0', f'{l2}:', '  dey', f'  bne {l2}', '  dex', f'  bne {l1}']
        left -= a * 1286 + 1
    # Tails: LDY #t / DEY / BNE costs 5t + 1 (t = 1..256).
    while left > 1291:
        l3 = label()
        lines += ['  ldy #0', f'{l3}:', '  dey', f'  bne {l3}']
        left -= 1281
    if left > 1200:
        l3 = label()
        lines += ['  ldy #128', f'{l3}:', '  dey', f'  bne {l3}']
        left -= 641
    t = (left - 1) // 5
    rest = left - (5 * t + 1)
    if rest == 1:
        t -= 1
        rest = 6
    if t >= 1:
        l3 = label()
        lines += [f'  ldy #{t % 256}', f'{l3}:', '  dey', f'  bne {l3}']
    else:
        rest = left
    fill = {0: [], 2: ['nop'], 3: ['bit $00'], 4: ['nop', 'nop'], 5: ['nop', 'bit $00'],
            6: ['nop', 'nop', 'nop'], 7: ['nop', 'nop', 'bit $00'], 8: ['nop', 'nop', 'nop', 'nop']}[rest]
    lines += [f'  {f}' for f in fill]
    return lines


def screen_rows(schedule):
    rows = ['TASDECK BOOT TIMING TEST', '', 'EXPECTED LOG GAPS AT DELAY 1', 'GAP    CYCLES   FRAMES']
    for i, gap in enumerate(schedule[:15]):
        rows.append(f'{i + 2:>3}   {gap:>7}   {gap / CYCLES_PER_FRAME:6.2f}')
    rows += ['', 'GAP 1 IS POWER-ON TO READ 1', 'AND WILL NOT MATCH.', f'{len(schedule) + 1} READS DONE. LOG CYCLES',
             'MAY DIFFER BY 0.03 PCT.', 'GAPS OF A WINNING GEG BOOT.']
    return rows


def source(schedule):
    out = ['.setcpu "6502"', '.segment "CODE"', 'reset:', '  sei', '  cld', '  ldx #$40', '  stx $4017',
           '  ldx #$FF', '  txs', '  inx', '  stx $2000', '  stx $2001', '  stx $4010', '  stx $4015',
           '  bit $2002', '@v1:', '  bit $2002', '  bpl @v1', '@v2:', '  bit $2002', '  bpl @v2',
           '  ldy #60', '@w:', '  bit $2002', '  bpl @w', '  dey', '  bne @w', '  jmp blk0']
    reads = len(schedule) + 1
    for i in range(reads):
        out += [f'.segment "B{i}"', f'blk{i}:', '  ldx #1', '  stx $4016', '  dex', '  stx $4016', '  ldx #8',
                f'@r{i}:', '  lda $4016', '  ror a', '  rol $15', '  lda $4017', '  ror a', '  rol $16', '  dex',
                f'  bne @r{i}']
        if i < len(schedule):
            out += delay_code(schedule[i] - READ_OVERHEAD)
            out += [f'  jmp blk{i + 1}', f'blk{i}_end:', f'.assert >blk{i} = >blk{i}_end, error, "block {i} crosses a page"']
        else:
            out += ['  jmp show']
    out += ['.segment "SHOW"', 'show:', '  bit $2002', '@s1:', '  bit $2002', '  bpl @s1',
            '  lda #$20', '  sta $2006', '  lda #0', '  sta $2006', '  ldx #4', '  ldy #0', '  lda #$20',
            '@clr:', '  sta $2007', '  iny', '  bne @clr', '  dex', '  bne @clr',
            '  lda #$3F', '  sta $2006', '  lda #0', '  sta $2006', '  ldx #0',
            '@pal:', '  lda palette,x', '  sta $2007', '  inx', '  cpx #32', '  bne @pal',
            '  lda #<text', '  sta $00', '  lda #>text', '  sta $01',
            '@row:', '  ldy #0', '  lda ($00),y', '  beq @done', '  sta $2006', '  iny', '  lda ($00),y', '  sta $2006',
            '@ch:', '  iny', '  lda ($00),y', '  cmp #$FF', '  beq @next', '  sta $2007', '  jmp @ch',
            '@next:', '  iny', '  tya', '  clc', '  adc $00', '  sta $00', '  bcc @row', '  inc $01', '  jmp @row',
            '@done:', '  bit $2002', '@s2:', '  bit $2002', '  bpl @s2', '  lda #0', '  sta $2005', '  sta $2005',
            '  lda #$0A', '  sta $2001', '@idle:', '  jmp @idle',
            'palette:', '  .byte $0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30',
            '  .byte $0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30', 'text:']
    for row, line in enumerate(screen_rows(schedule)):
        if line:
            addr = 0x2000 + (row + 2) * 32 + 2
            out.append(f'  .byte ${addr >> 8:02X},${addr & 0xFF:02X},"{line}",$FF')
    out += ['  .byte 0', 'nmi:', 'irq:', '  rti', '.segment "VECTORS"', '  .word nmi, reset, irq']
    return '\n'.join(out) + '\n'


def config(reads):
    mem = ['MEMORY {', '  PRG: start = $8000, size = $8000, file = %O, fill = yes, fillval = $EA;', '}', 'SEGMENTS {',
           '  CODE: load = PRG, type = ro, start = $8000;']
    for i in range(reads):
        mem.append(f'  B{i}: load = PRG, type = ro, start = ${0x8100 + i * 0x100:04X};')
    mem += [f'  SHOW: load = PRG, type = ro, start = ${0x8100 + reads * 0x100:04X};',
            '  VECTORS: load = PRG, type = ro, start = $FFFA;', '}']
    return '\n'.join(mem) + '\n'


def build(output, schedule=SCHEDULE):
    output.mkdir(parents=True, exist_ok=True)
    reads = len(schedule) + 1
    with tempfile.TemporaryDirectory(prefix='tasdeck-boot-timing-') as temp:
        work = Path(temp)
        (work / 'boot.s').write_text(source(schedule))
        (work / 'boot.cfg').write_text(config(reads))
        subprocess.run(['ca65', str(work / 'boot.s'), '-o', str(work / 'boot.o'), '-l', str(work / 'boot.lst')], check=True)
        subprocess.run(['ld65', '-C', str(work / 'boot.cfg'), str(work / 'boot.o'), '-o', str(work / 'boot.prg')], check=True)
        prg = (work / 'boot.prg').read_bytes()
        listing = (work / 'boot.lst').read_text()
    chr_rom = bytearray(8192)
    for char, rows in FONT.items():
        chr_rom[ord(char) * 16:ord(char) * 16 + 8] = bytes([int(row, 2) << 2 for row in rows.split('/')] + [0])
    rom = b'NES\x1a\x02\x01' + bytes(10) + prg + chr_rom
    files = {'TASDeck boot timing test.nes': rom, 'boot_timing_test.r08': bytes(2 * 64)}
    for name, content in files.items():
        (output / name).write_bytes(content)
    manifest = {
        'purpose': 'Compare TASDeck Boot timing log gaps with exact NES-side read intervals',
        'reads': reads,
        'schedule_cycles': schedule,
        'expected_log_gaps_from_gap_2': [{'gap': i + 2, 'cycles': g, 'frames': round(g / CYCLES_PER_FRAME, 2)}
                                          for i, g in enumerate(schedule)],
        'settings': {'ports': 2, 'sync_mode': 'strobe', 'delay': 1, 'skip': 0},
        'sha256': {n: hashlib.sha256(b).hexdigest() for n, b in files.items()},
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return listing


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
    print('built', parser.parse_args().output)
