"use client";
import { type LucideIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/src/components/ui/sidebar";
import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/src/utils/tailwind";
import { RouteGroup } from "@/src/components/layouts/routes";
import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const NAV_GROUP_ORDER: RouteGroup[] = [
  RouteGroup.Observability,
  RouteGroup.PromptManagement,
  RouteGroup.Evaluation,
];

const NAV_GROUP_LABELS: Record<RouteGroup, string> = {
  [RouteGroup.Observability]: i18nKey("Observability"),
  [RouteGroup.PromptManagement]: i18nKey("Prompt Management"),
  [RouteGroup.Evaluation]: i18nKey("Evaluation"),
};

export type NavMainItem = {
  title: string;
  menuNode?: ReactNode;
  url: string;
  icon?: LucideIcon;
  isActive?: boolean;
  label?: string | ReactNode;
  newTab?: boolean;
  items?: {
    title: string;
    url: string;
    isActive?: boolean;
    newTab?: boolean;
  }[];
};

function NavItemContent({ item }: { item: NavMainItem }) {
  const { t } = useTranslation();
  return (
    <>
      {item.icon && <item.icon />}
      <span>{t(item.title)}</span>
      {item.label &&
        (typeof item.label === "string" ? (
          <span
            className={cn(
              "-my-0.5 self-center rounded-sm border px-1 py-0.5 text-xs leading-none break-keep whitespace-nowrap",
            )}
          >
            {t(item.label)}
          </span>
        ) : (
          // ReactNode
          item.label
        ))}
    </>
  );
}

export function NavMain({
  items,
}: {
  items: {
    grouped: Partial<Record<RouteGroup, NavMainItem[]>> | null;
    ungrouped: NavMainItem[];
  };
}) {
  const { t } = useTranslation();
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {items.ungrouped.map((item) => (
              <SidebarMenuItem key={item.title}>
                {item.menuNode || (
                  <SidebarMenuButton
                    asChild
                    tooltip={t(item.title)}
                    isActive={item.isActive}
                  >
                    <Link
                      href={item.url}
                      target={item.newTab ? "_blank" : undefined}
                    >
                      <NavItemContent item={item} />
                    </Link>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {items.grouped &&
        NAV_GROUP_ORDER.filter((group) => items.grouped?.[group]?.length).map(
          (group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>
                {t(NAV_GROUP_LABELS[group])}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.grouped?.[group]?.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      {item.menuNode || (
                        <SidebarMenuButton
                          asChild
                          tooltip={t(item.title)}
                          isActive={item.isActive}
                        >
                          <Link
                            href={item.url}
                            target={item.newTab ? "_blank" : undefined}
                          >
                            <NavItemContent item={item} />
                          </Link>
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ),
        )}
    </>
  );
}
