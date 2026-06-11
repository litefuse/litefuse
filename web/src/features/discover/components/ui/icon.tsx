// @ts-nocheck
"use client";

import type { CSSProperties, ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Braces,
  Building2,
  Calendar,
  Check,
  CircleMinus,
  CirclePlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CirclePercent,
  Clock3,
  Clock9,
  Code2,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Funnel,
  GripVertical,
  Info,
  List,
  Loader2,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Table2,
  TextCursorInput,
  ToggleRight,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/src/utils/tailwind";

type IconComponent = ComponentType<LucideProps>;

const ICON_MAP: Record<string, IconComponent> = {
  search: Search,
  arrow: ArrowRight,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevron-left": ChevronLeft,
  "chevron-up": ChevronUp,
  times: X,
  "times-circle": X,
  plus: Plus,
  "plus-circle": CirclePlus,
  minus: Minus,
  "minus-circle": CircleMinus,
  cog: Settings,
  edit: Pencil,
  trash: Trash2,
  "trash-alt": Trash2,
  filter: Funnel,
  sync: RefreshCw,
  spinner: Loader2,
  copy: Copy,
  download: Download,
  "external-link-alt": ExternalLink,
  calendar: Calendar,
  clock: Clock3,
  "clock-nine": Clock9,
  database: Database,
  table: Table2,
  code: Code2,
  sliders: SlidersHorizontal,
  info: Info,
  "info-circle": Info,
  check: Check,
  eye: Eye,
  "eye-slash": EyeOff,
  "angle-double-left": ChevronLeft,
  "angle-double-right": ChevronRight,
  "angle-left": ChevronLeft,
  "angle-right": ChevronRight,
  "angle-down": ChevronDown,
  "text-fields": TextCursorInput,
  percentage: CirclePercent,
  "brackets-curly": Braces,
  "list-ul": List,
  "toggle-on": ToggleRight,
  building: Building2,
  draggabledots: GripVertical,
};

const SIZE_MAP: Record<string, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
  xl: "h-6 w-6",
};

export function normalizeIconName(name: string) {
  if (name.includes("spinner")) {
    return "spinner";
  }

  return name.replace(/^fa\s+fa-/, "").replace(/^fa-/, "");
}

export function Icon({
  name,
  size = "md",
  className,
  style,
}: {
  name: string;
  size?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const normalizedName = normalizeIconName(name);
  const LucideIcon = ICON_MAP[normalizedName] ?? MoreHorizontal;

  return (
    <LucideIcon
      className={cn(
        SIZE_MAP[size] ?? SIZE_MAP.md,
        normalizedName === "spinner" && "animate-spin",
        className,
      )}
      style={style}
    />
  );
}
