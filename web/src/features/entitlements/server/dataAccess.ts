import { type FilterState, type TimeFilter } from "@langfuse/shared";
import { type User } from "next-auth";
import { hasEntitlementLimit } from "./hasEntitlementLimit";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const getDataAccessCutoff = ({
  dataAccessDays,
  now = new Date(),
}: {
  dataAccessDays: number | false;
  now?: Date;
}): Date | undefined => {
  if (dataAccessDays === false) return undefined;
  return new Date(now.getTime() - dataAccessDays * MS_PER_DAY);
};

export const getDataAccessLimitFilter = ({
  dataAccessDays,
  timestampColumn,
  now,
}: {
  dataAccessDays: number | false;
  timestampColumn: string;
  now?: Date;
}): TimeFilter[] => {
  const cutoff = getDataAccessCutoff({ dataAccessDays, now });
  if (!cutoff) return [];

  return [
    {
      column: timestampColumn,
      type: "datetime",
      operator: ">=",
      value: cutoff,
    },
  ];
};

export const getProjectDataAccessLimitFilter = ({
  sessionUser,
  projectId,
  timestampColumn,
  now,
}: {
  sessionUser: User;
  projectId: string;
  timestampColumn: string;
  now?: Date;
}): TimeFilter[] => {
  const dataAccessDays = hasEntitlementLimit({
    entitlementLimit: "data-access-days",
    sessionUser,
    projectId,
  });

  return getDataAccessLimitFilter({
    dataAccessDays,
    timestampColumn,
    now,
  });
};

export const applyDataAccessLimit = ({
  filter,
  dataAccessDays,
  timestampColumn,
  now,
}: {
  filter: FilterState;
  dataAccessDays: number | false;
  timestampColumn: string;
  now?: Date;
}): FilterState => {
  if (dataAccessDays === false) return filter;

  return [
    ...filter,
    ...getDataAccessLimitFilter({
      dataAccessDays,
      timestampColumn,
      now,
    }),
  ];
};
