// seedfinder — find Minecraft seeds whose spawn area contains the biomes you
// asked for. A tiny CLI over cubiomes (MIT, github.com/Cubitect/cubiomes) that
// the Electron engine spawns as a child process and reads line-by-line.
//
// Why a native helper rather than JS: cubiomes reproduces vanilla terrain at
// ~99.97% (validated on the Mac side against real .mca biome palettes), and a
// hand-port of its noise generators would be thousands of lines that would all
// need re-validating. Compiling the real thing is both faster and honest.
//
// ⚠️ THE TRAP THAT SILENTLY RUINS RESULTS: str2mc() returns 0 — its OLDEST
// biome model — for a version string it doesn't know, not a negative. Passing
// that through would generate terrain from an ancient Minecraft and report it
// as the user's version. Only values > 0 are trusted, and only for "1.x"
// strings; anything else (26.x and later) uses MC_NEWEST, which is correct
// because overworld biome placement is unchanged 1.21 -> 26.x.
//
// Usage:
//   seedfinder <mcVersion> <radius> <wanted> <spacing> <startSeed> <biome,...>
// Emits one JSON object per line for each matching seed, then a final
// {"done":true,...}. Progress lines keep the UI honest on a long search.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "cubiomes/include/generator.h"
#include "cubiomes/include/util.h"

#define MAX_WANTED 16

static int resolve_mc(const char *version)
{
    // Only "1.x" strings can be looked up; str2mc gives 0 for anything else.
    if (version && version[0] == '1' && version[1] == '.') {
        int mc = str2mc(version);
        if (mc > 0) return mc;
    }
    return MC_NEWEST;
}

int main(int argc, char **argv)
{
    if (argc < 7) {
        fprintf(stderr, "usage: seedfinder <mcVersion> <radius> <wanted> <spacing> <startSeed> <biome,...>\n");
        return 2;
    }

    const char *version = argv[1];
    int radius   = atoi(argv[2]);          // blocks from origin to search
    int wanted   = atoi(argv[3]);          // how many matching seeds to return
    int spacing  = atoi(argv[4]);          // sample step in blocks
    uint64_t seed = strtoull(argv[5], NULL, 10);

    if (radius < 64) radius = 64;
    if (radius > 8192) radius = 8192;      // keep one seed's check bounded
    if (wanted < 1) wanted = 1;
    if (wanted > 50) wanted = 50;
    if (spacing < 16) spacing = 16;

    int mc = resolve_mc(version);

    // Parse the requested biome ids from their cubiomes names.
    int want_ids[MAX_WANTED];
    int want_count = 0;
    {
        char *list = strdup(argv[6]);
        char *tok = strtok(list, ",");
        while (tok && want_count < MAX_WANTED) {
            int found = -1;
            for (int id = 0; id < 256 && found < 0; id++) {
                const char *nm = biome2str(mc, id);
                if (nm && strcmp(nm, tok) == 0) found = id;
            }
            if (found < 0) {
                fprintf(stderr, "unknown biome: %s\n", tok);
                free(list);
                return 3;
            }
            want_ids[want_count++] = found;
            tok = strtok(NULL, ",");
        }
        free(list);
    }
    if (want_count == 0) { fprintf(stderr, "no biomes requested\n"); return 2; }

    Generator g;
    setupGenerator(&g, mc, 0);

    int found = 0;
    uint64_t checked = 0;
    // Scale 4 is the biome-lattice resolution cubiomes generates at; sampling
    // finer than that costs time without adding information.
    const int scale = 4;

    while (found < wanted) {
        applySeed(&g, DIM_OVERWORLD, seed);

        int hits[MAX_WANTED];
        memset(hits, 0, sizeof(hits));
        int remaining = want_count;

        for (int x = -radius; x <= radius && remaining > 0; x += spacing) {
            for (int z = -radius; z <= radius && remaining > 0; z += spacing) {
                int b = getBiomeAt(&g, scale, x >> 2, 63 >> 2, z >> 2);
                for (int i = 0; i < want_count; i++) {
                    if (!hits[i] && b == want_ids[i]) { hits[i] = 1; remaining--; }
                }
            }
        }

        if (remaining == 0) {
            printf("{\"seed\":\"%lld\"}\n", (long long)seed);
            fflush(stdout);
            found++;
        }

        checked++;
        seed++;
        // A heartbeat so the UI can show real progress instead of a spinner
        // that might be hiding a hang.
        if ((checked % 256) == 0) {
            printf("{\"progress\":%llu,\"found\":%d}\n", (unsigned long long)checked, found);
            fflush(stdout);
        }
        if (checked > 5000000ULL) break;   // hard stop; never spin forever
    }

    printf("{\"done\":true,\"checked\":%llu,\"found\":%d}\n", (unsigned long long)checked, found);
    fflush(stdout);
    return 0;
}
