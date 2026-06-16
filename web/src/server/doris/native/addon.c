// litefuse in-process Doris — N-API addon.
//
// Minimal Node-API addon that dlopen()s libdoris_lite.dylib and runs the BE's
// exported doris_be_run() on a dedicated pthread, so Doris (BE + in-process
// JVM FE) lives inside the same OS process as Node.js/V8. doris_be_stop() asks
// the BE run loop to wind down.
//
// V8 and Doris can co-reside in one process only because Doris's process-global
// signal handlers and _exit() are gated off when DORIS_LITE_EMBED=1 (set by
// embeddedDoris.ts). This addon links nothing from Doris at build time — it only
// needs libdl + pthread — so it builds independently of the (huge) Doris dylib
// and finds doris_be_run/doris_be_stop via dlsym at runtime.

#include <node_api.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*doris_be_run_fn)(int, char **);
typedef void (*doris_be_stop_fn)(void);

static void *g_handle = NULL;
static doris_be_run_fn g_run = NULL;
static doris_be_stop_fn g_stop = NULL;
static pthread_t g_thread;
static int g_thread_started = 0;

// argv handed to doris_be_run must outlive this call (the BE run loop keeps
// running on the thread), so keep it static.
static char g_arg0[] = "doris_be";
static char *g_argv[] = {g_arg0, NULL};

static void *run_thread(void *arg) {
  (void)arg;
  fprintf(stderr, "[doris-embed] doris_be_run thread entering...\n");
  int rc = g_run(1, g_argv);
  fprintf(stderr, "[doris-embed] doris_be_run returned rc=%d\n", rc);
  return NULL;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  char path[4096];
  size_t plen = 0;
  if (argc < 1 ||
      napi_get_value_string_utf8(env, args[0], path, sizeof(path), &plen) !=
          napi_ok) {
    napi_throw_error(env, NULL,
                     "start(path) requires a string path to libdoris_lite.dylib");
    return NULL;
  }

  g_handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (!g_handle) {
    char msg[4608];
    snprintf(msg, sizeof(msg), "dlopen failed: %s", dlerror());
    napi_throw_error(env, NULL, msg);
    return NULL;
  }

  g_run = (doris_be_run_fn)dlsym(g_handle, "doris_be_run");
  g_stop = (doris_be_stop_fn)dlsym(g_handle, "doris_be_stop");
  if (!g_run || !g_stop) {
    char msg[256];
    snprintf(msg, sizeof(msg), "dlsym failed: run=%p stop=%p (%s)",
             (void *)g_run, (void *)g_stop, dlerror());
    napi_throw_error(env, NULL, msg);
    return NULL;
  }

  if (pthread_create(&g_thread, NULL, run_thread, NULL) != 0) {
    napi_throw_error(env, NULL, "pthread_create failed");
    return NULL;
  }
  g_thread_started = 1;

  napi_value out;
  napi_get_boolean(env, true, &out);
  return out;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  (void)info;
  if (g_stop) {
    fprintf(stderr, "[doris-embed] calling doris_be_stop()\n");
    g_stop();
  }
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

// Join the BE thread (blocks until the run loop has exited after stop()).
static napi_value Join(napi_env env, napi_callback_info info) {
  (void)info;
  if (g_thread_started) {
    pthread_join(g_thread, NULL);
    g_thread_started = 0;
  }
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn_start, fn_stop, fn_join;
  napi_create_function(env, NULL, 0, Start, NULL, &fn_start);
  napi_create_function(env, NULL, 0, Stop, NULL, &fn_stop);
  napi_create_function(env, NULL, 0, Join, NULL, &fn_join);
  napi_set_named_property(env, exports, "start", fn_start);
  napi_set_named_property(env, exports, "stop", fn_stop);
  napi_set_named_property(env, exports, "join", fn_join);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
