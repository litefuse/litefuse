// @ts-nocheck
import { DEFAULT_OPERATION, DEFAULT_SERVICE } from "../constants";
import { atom } from "jotai";

export const currentTraceTableAtom = atom<string>("");
export const currentServiceAtom = atom<any>(DEFAULT_SERVICE);
export const currentOperationAtom = atom<any>(DEFAULT_OPERATION);
export const currentSortAtom = atom<any>("most-recent");
export const tagsAtom = atom<string>("");
export const tracesAtom = atom<any>([]);
export const tracesServicesAtom = atom<any>([]);
export const traceOperationsAtom = atom<any>([]);
export const minDurationAtom = atom<any>("");
export const maxDurationAtom = atom<any>("");
