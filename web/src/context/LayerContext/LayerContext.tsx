import * as React from "react";

import { LAYER_ORDER, type LayerName } from "./layers";

// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream mounts <LayerProvider> in the app shell, so its useLayerContainer
// always has a container map. Litefuse has no layer system and wrapping our app
// shell would mean editing a file outside the evaluator module.
//
// This version builds the SAME container tree lazily on the client and falls
// back to it when no provider is mounted, so upstream's Layer / CustomTooltip /
// DropdownMenu copies work unchanged:
//
//   <body> <div data-overlay-root>
//            <div data-layer="panel|agent|modal|popover|tooltip|toast"> ...
//
// It is intentionally a superset of upstream's export surface, not a
// replacement for anything in our tree.
// ─────────────────────────────────────────────────────────────────────────────

const LayerContext = React.createContext<Map<LayerName, HTMLElement> | null>(
  null,
);

let memoizedLayers: Map<LayerName, HTMLElement> | null = null;

function ensureLayerContainers(): Map<LayerName, HTMLElement> {
  if (memoizedLayers) return memoizedLayers;

  let root = document.querySelector<HTMLElement>("[data-overlay-root]");
  if (!root) {
    root = document.createElement("div");
    root.setAttribute("data-overlay-root", "");
    document.body.appendChild(root);
  }

  const containers = new Map<LayerName, HTMLElement>();
  for (const name of LAYER_ORDER) {
    let layer = root.querySelector<HTMLElement>(
      `[data-layer="${CSS.escape(name)}"]`,
    );
    if (!layer) {
      layer = document.createElement("div");
      layer.setAttribute("data-layer", name);
      root.appendChild(layer);
    }
    containers.set(name, layer);
  }
  memoizedLayers = containers;
  return containers;
}

export function LayerProvider({ children }: { children: React.ReactNode }) {
  const [layers] = React.useState<Map<LayerName, HTMLElement> | null>(() =>
    typeof document === "undefined" ? null : ensureLayerContainers(),
  );
  return (
    <LayerContext.Provider value={layers}>{children}</LayerContext.Provider>
  );
}

/** The container for a layer, or null during SSR. */
export function useLayerContainer(name: LayerName): HTMLElement | null {
  const fromProvider = React.useContext(LayerContext);
  const [lazy] = React.useState<HTMLElement | null>(() =>
    typeof document === "undefined"
      ? null
      : (ensureLayerContainers().get(name) ?? null),
  );
  return fromProvider?.get(name) ?? lazy;
}
