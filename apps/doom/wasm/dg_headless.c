// Headless DG_ port: the real engine, no SDL, no canvas.
//
// Runs DOOM for a fixed number of ticks under node so the WAD load and the
// intro demo playback execute for real before anything ships to the TV.
// DG_DrawFrame is a no-op: the framebuffer is plain memory, DOOM renders
// into it either way.
#include <stdint.h>
#include <stdio.h>

#include <emscripten.h>

#include "doomgeneric.h"

void DG_Init(void) {}

void DG_DrawFrame(void) {}

void DG_SleepMs(uint32_t ms) { (void)ms; } // flat out; the tick clock paces DOOM

uint32_t DG_GetTicksMs(void) { return (uint32_t)emscripten_get_now(); }

int DG_GetKey(int *pressed, unsigned char *key) {
  (void)pressed;
  (void)key;
  return 0; // no input: DOOM plays its intro demo
}

void DG_SetWindowTitle(const char *title) { printf("TITLE: %s\n", title); }

int main(int argc, char **argv) {
  printf("HEADLESS: creating\n");
  doomgeneric_Create(argc, argv); // full DOOM init: WAD parse, R_Init, ...
  printf("HEADLESS: created, ticking\n");
  // ~20 seconds of game time; the intro demo drives real level code.
  for (int i = 0; i < 35 * 20; i++) {
    doomgeneric_Tick();
  }
  printf("HEADLESS_OK\n");
  return 0;
}
