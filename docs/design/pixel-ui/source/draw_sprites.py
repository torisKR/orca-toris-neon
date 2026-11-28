"""Authoring source for the Neon workshop sprites. Run with Python 3 and Pillow.

All grids are original and one character per native pixel. Production loads PNG/CSS only.
"""
from pathlib import Path
from PIL import Image, ImageColor

OUT = Path(__file__).resolve().parents[4] / "panel" / "pixel"
CORE = {
    'o': '#090f19', 'g': '#263750', 'G': '#405775', 'H': '#6a83a0',
    's': '#d3a58d', 'S': '#f8d6b0', 'e': '#172035', 'w': '#f0f5fa',
    'm': '#92a8c5', 'c': '#7ce9c6', 'a': '#ffce80', 'r': '#ff8e97',
}
TEAMS = {
    'plan': ('#4374aa', '#72ace6', '#a9d1ff', 'paper', 'cap'),
    'arch': ('#665397', '#aa8fea', '#d7c8ff', 'grid', 'visor'),
    'design': ('#914e7b', '#de85b6', '#ffc1e3', 'paint', 'beret'),
    'build': ('#9c552f', '#e2915c', '#ffceaa', 'terminal', 'headset'),
    'money': ('#974766', '#e276a2', '#ffbfd9', 'coin', 'bow'),
    'qa': ('#327d6a', '#68c2ac', '#a9ead9', 'scope', 'goggles'),
    'ship': ('#8a6f37', '#cbb06a', '#f2de9e', 'parcel', 'hood'),
    'other': ('#526783', '#849ab8', '#c6d5e9', 'terminal', 'cap'),
}
ROWS = (
    ('work', 4), ('start', 4), ('start-slow', 1), ('retry', 4),
    ('quiet', 1), ('queue', 1), ('dependency', 1), ('approval', 1),
    ('review', 4), ('passed', 1), ('failed', 1), ('blocked', 1),
    ('skipped', 1), ('cancelled', 1), ('completed', 1), ('report', 1),
    ('idle', 1), ('paused', 1), ('unknown', 1),
)

HEAD = (
    '..ooooo...', '.oBBBBBo..', 'oBLLBBBBo.', 'oBBBBBBBBo',
    'oBSSSSSSo.', 'oSSSeSeSo.', 'oSSSSSSSo.', '.oSssssso.',
    '..oooooo..',
)
HATS = {
    'cap': ('...oooo...', '..oBLLBo..', '.oBBBBBBo.', 'oBLLLLLooo'),
    'visor': ('..oooooo..', '.oLLLLLBo.', 'oBBGGGGBoo', 'oLLGGHGLBo'),
    'beret': ('..o.......', '.oBoooo...', 'oLLBBBBoo.', 'oBBBBBBBo.'),
    'headset': ('..ooooo...', '.oBBBBBo..', 'oBLLBBBo..', 'oBBoBBBo..', 'oBGGSSSSo.', 'oBGGeSeSo.', 'oBGoSSSSo.', '.oBGsssGo.'),
    'bow': ('o...o.....', 'oBoBo.....', 'oLLLo.....', '.oBoooo...'),
    'goggles': ('..ooooo...', '.oBBBBBo..', 'oBLLBBBBo.', 'oBBBBBBBBo', 'oBGHGGHGo.', 'oBGHGGHGo.', 'oSSSSSSSo.'),
    'hood': ('...oooo...', '..oLLLLo..', '.oBLBBBBo.', '.oBBBBBBo.', 'oBBSSSSBo.', 'oBSSeSeBo.', 'oBSSSSSBo.', '.oBssssBo.'),
}
BODY = ('..oooooo..', '.oLLLLDDo.', 'oBLBBBBBBo', 'oBLBBBBDBo', '.oBBBBBDDo', '..oDDDDoo.')
STAND = ('..oGGoGo..', '..oGGoGo..', '.oHHooHHo.', '.ooooooo..')
WALK_A = ('.oGGo.oGo.', '.oGGo.oGo.', 'oHHoo..oGo', 'oooo...ooo')
WALK_B = ('..oGGoGGo.', '..oGooGGo.', '.oHHo.oHHo', '.oooo.oooo')
DESK = (
    '.ooooooooooo.', 'oHHHHHHHHHHHo',
    'oGGGGGGGGGGGo', '.ooooooooooo.', '..oGo...oGo..', '..oGo...oGo..',
    '..oGo...oGo..', '..ooo...ooo..',
)
DESK_ICONS = {
    'paper': ('..oooooo.', '.owwwwwo.', '.owHmmwo.', 'owwmmwo..', 'owwwwo...', '.oooo....'),
    'grid': ('.oooooooo', '.oBBLBBLo', 'oBLLwLLBo', 'oBBwLwBBo', 'oBLBLBLBo', '.ooooooo.'),
    'paint': ('..ooooo..', '.owrwaao.', 'owwcccwwo', 'owwwwowwo', '.oowwwoo.', '...ooo...'),
    'terminal': ('.oooooooo', 'oHgggggGo', 'oHgccggGo', 'oHggcggGo', 'oHGcccGGo', '.oooooooo', '...oGGo..'),
    'coin': ('..ooooo..', '.oaaaaao.', 'oaawawaro', 'oaarararo', '.oaaraao.', '..ooooo..'),
    'scope': ('.oooooo..', 'oHHGGGGo.', 'oHccGcGo.', 'oHGccGGo.', '.ooooooo.', '...oHoo..'),
    'parcel': ('..oooo...', '.oaGaao..', 'oaawraao.', 'oaaGraao.', 'oaaaaaao.', '.oooooo..'),
}
DOOR = (
    '..oooooooooo..', '.oHHHHHHHHHGo.', '.oGgggggggGGo.', '.oGHGGGGGgGGo.',
    '.oGGGGGGGgGGo.', '.oGGgggGGgGGo.', '.oGGGGGGGgGGo.', '.oGGGGGGGgGGo.',
    '.oGGGGGGGgGGo.', '.oGwwGGGGgGGo.', '.oGGGGGGGgGGo.', '.oGGGGGGGgGGo.',
    '.oGGGGGGGgGGo.', '.oGGGGGGGgGGo.', '.oGgggggggGGo.', '.oGgggggggGGo.',
    '.oGGGGGGGGGGo.', 'oHHHHHHHHHHGGo', 'oooooooooooooo',
)
SIGNS = {
    'clock': ('..ooo..','.owwwo.','owwwmwo','owwwmwo','owwmmwo','.owwwo.','..ooo..'),
    'retry': ('.......','..aa...','..a.a..','...a...','.......','..aa...','.......'),
    'quiet': ('.......','.m.....','.mm....','....mm.','.....m.','.......','.......'),
    'queue': ('.ooooo.','owowowo','omwwwmo','owmmmwo','omwwwmo','owowowo','.ooooo.'),
    'dependency': ('ooooooo','oaaaaao','.oawo..','..oo...','.oawo..','oawwawo','ooooooo'),
    'approval': ('..oo...','..ow...','..ow.o.','.oowwoo','owwwwwo','.owwwo.','..ooo..'),
    'passed': ('.....c.','....cc.','...cc..','c.cc...','ccc....','.c.....','.......'),
    'failed': ('rr...rr','.rr.rr.','..rrr..','...r...','..rrr..','.rr.rr.','rr...rr'),
    'blocked': ('..aaa..','.a...a.','.a...a.','aaaaaaa','aararaa','aararaa','aaaaaaa'),
    'skipped': ('...m...','....m..','mmmmmm.','mmmmmmm','....m..','...m...','.......'),
    'cancelled': ('mmmmmmm','m.....m','m.mmm.m','m.mmm.m','m.mmm.m','m.....m','mmmmmmm'),
    'completed': ('ccccccc','.ccccc.','..ccc..','...c...','...c...','..ccc..','.ccccc.'),
    'report': ('oooooo.','owwwwo.','owmmwoo','owwwmwo','owmmwwo','owwwwwo','ooooooo'),
    'paused': ('.......','.mm.mm.','.mm.mm.','.mm.mm.','.mm.mm.','.mm.mm.','.......'),
    'unknown': ('.mmmm..','....mm.','...mm..','..mm...','..mm...','.......','..mm...'),
}
MAG = ('..oooo...', '.oHHHGo..', 'oHwwwmGo.', 'oHwwwmGo.', '.oHHGGoo.', '..ooooHGo', '......GHo', '.......oo')
STAMPS = {
    'draft': ('..oooo.', '.owwwo.', '.owmmo.', '.owwwo.', '.owmmo.', '.owwwo.', '.ooooo.'),
    'in_review': SIGNS['dependency'],
    'published': SIGNS['passed'],
    'rejected': SIGNS['failed'],
    'approved_not_published': ('..aaa..','.aaaaa.','aaaaaaa','aaaaaaa','.aaaaa.','..aaa..','...a...'),
    'no_production': ('.......','.mmmmm.','.m...m.','.m...m.','.m...m.','.mmmmm.','.......'),
    'lookup_error': ('..rrr..','..rrr..','..rrr..','...r...','.......','..rrr..','..rrr..'),
    'stale': SIGNS['clock'],
    'unknown': SIGNS['unknown'],
    'desk': DESK,
    'desk-busy': tuple(line.replace('H','c').replace('G','H') for line in DESK),
    'desk-heavy': tuple(line.replace('H','a').replace('G','H') for line in DESK),
    'app': ('.ooooooooo.','oGGHHHGGGGo','oGHgggHGGGo','oGHgcggHGGo','oGHgccgHGGo','oGHgcggHGGo','oGHgggHGGGo','oGGHHHGGGGo','.ooooooooo.'),
    'neon': ('oo.........oo','oGHHHHHHHHHGo','.HgggggggggH.','.HgccgggcgH.','.HgcwcggcgH.','.HgcgwcgcgH.','.HgcggwccgH.','.HgcgggccgH.','.HggggggggH.','oGHHHHHHHHGo.','oo.........oo'),
}

def place(canvas, grid, x, y, palette):
    for dy, row in enumerate(grid):
        for dx, mark in enumerate(row):
            if mark != '.':
                canvas.putpixel((x + dx, y + dy), palette[mark])


def actor(canvas, palette, hat, x, y, step=None):
    place(canvas, HEAD, x, y, palette)
    place(canvas, HATS[hat], x, y, palette)
    place(canvas, BODY, x, y + 8, palette)
    place(canvas, WALK_A if step == 1 else WALK_B if step == 3 else STAND, x, y + 13, palette)


def sprite(team, state, frame):
    dark, base, light, prop, hat = TEAMS[team]
    palette = {key: ImageColor.getrgb(value) + (255,) for key, value in {
        **CORE, 'D': dark, 'B': base, 'L': light,
    }.items()}
    im = Image.new("RGBA", (32, 32))
    def put(grid, x, y):
        place(im, grid, x, y, palette)
    def person(x, y, step=None):
        actor(im, palette, hat, x, y, step)

    put(('..gggggggggggggggggggggggggg..', 'gggggggggggggggggggggggggggggg', '..gggggggggggggggggggggggggg..'), 1, 25)
    if state in ('work', 'review', 'quiet', 'passed', 'failed', 'report'):
        if state == 'quiet':
            put(STAND, 3, 22)
            put(BODY, 4, 17)
            put(HEAD, 8, 13)
            put(HATS[hat], 8, 13)
            put(('.....ee...',), 8, 18)
        else:
            person(2, 8)
        put(DESK, 16, 19)
        if state == 'review':
            put(DESK_ICONS['paper'], 18, 13)
            put(MAG, 13 + (frame in (1, 2)) * 2, 7 + (frame == 2))
        else:
            put(DESK_ICONS[prop], 18, 12)
        if state == 'work':
            reach = frame in (1, 3)
            put(('ooSSo', 'oLSSo', '.ooo.') if reach else ('oSSo','oLSo','.oo.'), 12 + reach, 17 + (frame == 2))
            put(('.c.', 'ccc', '.c.') if frame in (1, 3) else ('cc',), 25 if frame in (0, 1) else 28, 5 if frame % 2 else 8)
        elif state == 'quiet':
            put(('.ooooo.', 'oLSSSSo', '.ooooo.'), 11, 19)
            put(SIGNS['quiet'], 14, 4)
        elif state in ('passed', 'failed', 'report'):
            put(SIGNS[state], 20, 1)
    elif state in ('start', 'start-slow'):
        offset = frame if state == 'start' else 2
        person(1 + offset, 9, frame if state == 'start' else None)
        put(DESK, 17, 19)
        put(DESK_ICONS[prop], 19, 12)
        if state == 'start-slow':
            put(SIGNS['clock'], 16, 2)
    elif state in ('retry', 'blocked'):
        person(2, 9)
        put(DOOR, 17, 8)
        if state == 'retry':
            put(('.oo.Soo', 'oLLSSSo', 'oooooo.') if frame == 1 else ('oSSo','oLSo','.oo.'), 11, 15 if frame == 1 else 17)
            put(SIGNS['retry'], 15, 1)
            if frame in (1, 2):
                put(('a.a','.a.'), 14, 11)
        else:
            put(SIGNS['blocked'], 21, 11)
    else:
        person(6, 9)
        if state == 'approval':
            put(('...oo','..oSo','..oSo','..oSo','.oBSo','oLBoo','oLoo.'), 13, 12)
        if state in SIGNS:
            put(SIGNS[state], 19, 5)
    return im


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    for team in TEAMS:
        sheet = Image.new("RGBA", (128, 32 * len(ROWS)))
        for row, (state, frames) in enumerate(ROWS):
            for frame in range(frames):
                sheet.paste(sprite(team, state, frame), (32 * frame, 32 * row))
        sheet.save(OUT / f"crew-{team}.png", optimize=True)
    palette = {key: ImageColor.getrgb(value) + (255,) for key, value in CORE.items()}
    sheet = Image.new("RGBA", (16 * len(STAMPS), 16))
    for i, grid in enumerate(STAMPS.values()):
        place(sheet, grid, 16 * i + (16 - max(map(len, grid))) // 2, (16 - len(grid)) // 2, palette)
    sheet.save(OUT / "marks.png", optimize=True)


if __name__ == "__main__":
    build()
