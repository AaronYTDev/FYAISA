# doomgeneric -> WebAssembly, for the Vega OS WebView.
#
# Adapted from doomgeneric's own Makefile.emscripten. Differences:
#   - no sound: FEATURE_SOUND off, SDL2_mixer files dropped. The shareware
#     episode plays in silence for now, and SDL2_mixer drags timidity
#     configs in.
#   - SINGLE_FILE: wasm + WAD inline in one .js, so the whole game is a
#     single string that can be chunked into the WebView (its bridge drops
#     big payloads).
#   - --embed-file, not --preload-file: preload writes a sidecar .data file
#     that SINGLE_FILE does not inline.
#
# Two targets:
#   doom.js          - the real build (SDL2 -> canvas), what ships on the TV
#   doom_headless.js - same engine, no SDL, fixed tick count; runs in node
#                      so the WAD parse and demo playback can be smoke-tested
DG ?= doomgeneric/doomgeneric
CC = emcc
CFLAGS = -O2 -I$(DG)
COMMON_LDFLAGS = -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sSTACK_SIZE=1048576 -sASSERTIONS=0 --embed-file doom1.wad@/doom1.wad

# Core engine (the official list minus the SDL_mixer sound files).
SRC_CORE = dummy am_map doomdef doomstat dstrings d_event d_items d_iwad \
  d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus \
  i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox \
  m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng \
  p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats \
  p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user \
  r_bsp r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds \
  statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file \
  w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric

OBJS_CORE = $(addprefix obj/, $(addsuffix .o, $(SRC_CORE)))

all: doom.js doom_headless.js

obj:
	mkdir -p obj

obj/%.o: $(DG)/%.c | obj
	$(CC) $(CFLAGS) -c $< -o $@

obj/doomgeneric_emscripten.o: $(DG)/doomgeneric_emscripten.c | obj
	$(CC) $(CFLAGS) -sUSE_SDL=2 -c $< -o $@

obj/dg_headless.o: dg_headless.c | obj
	$(CC) $(CFLAGS) -c $< -o $@

# The shipping build: SDL2 canvas port, everything inlined in one .js.
doom.js: $(OBJS_CORE) obj/doomgeneric_emscripten.o doom1.wad
	$(CC) $(CFLAGS) -sUSE_SDL=2 $(COMMON_LDFLAGS) -sSINGLE_FILE=1 \
	  $(OBJS_CORE) obj/doomgeneric_emscripten.o -o doom.js -lm

# The smoke-test build: my own DG_ stubs, a fixed number of ticks, exit 0.
doom_headless.js: $(OBJS_CORE) obj/dg_headless.o doom1.wad
	$(CC) $(CFLAGS) $(COMMON_LDFLAGS) -sSINGLE_FILE=1 \
	  $(OBJS_CORE) obj/dg_headless.o -o doom_headless.js -lm

clean:
	rm -rf obj doom.js doom_headless.js
