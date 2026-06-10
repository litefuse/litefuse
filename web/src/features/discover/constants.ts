// @ts-nocheck
import { AutoInterval } from "types/type";
import { Dayjs } from "dayjs";
import { groupBy } from "lodash-es";

export enum ROUTES {
  One = "one",
  Discover = "discover",
  Traces = "traces",
  Dashboard = "dashboard",
}

export const FORMAT_DATE = "YYYY-MM-DD HH:mm:ss";
export enum IntervalEnum {
  Auto = "auto",
  Day = "day",
  Week = "week",
  Month = "month",
  Year = "year",
  Hour = "hour",
  Minute = "minute",
  Second = "second",
}

export const DEFAULT_SERVICE = { value: "all", label: "ALL" };
export const DEFAULT_OPERATION = { value: "all", label: "ALL" };

export const AUTO_INTERVALS = [
  {
    current_date_range: 3,
    current_type: "year",
    interval_unit: "month",
    interval_value: 1,
  },
  {
    current_date_range: 1,
    current_type: "year",
    interval_unit: "week",
    interval_value: 1,
  },
  {
    current_date_range: 1,
    current_type: "month",
    interval_unit: "day",
    interval_value: 1,
  },
  {
    current_date_range: 1,
    current_type: "week",
    interval_unit: "hour",
    interval_value: 12,
  },
  {
    current_date_range: 4,
    current_type: "day",
    interval_unit: "hour",
    interval_value: 3,
  },
  {
    current_date_range: 1,
    current_type: "day",
    interval_unit: "hour",
    interval_value: 1,
  },
  {
    current_date_range: 16,
    current_type: "hour",
    interval_unit: "minute",
    interval_value: 30,
  },
  {
    current_date_range: 8,
    current_type: "hour",
    interval_unit: "minute",
    interval_value: 10,
  },
  {
    current_date_range: 2,
    current_type: "hour",
    interval_unit: "minute",
    interval_value: 5,
  },
  {
    current_date_range: 38,
    current_type: "minute",
    interval_unit: "minute",
    interval_value: 1,
  },
  {
    current_date_range: 13,
    current_type: "minute",
    interval_unit: "second",
    interval_value: 30,
  },
  {
    current_date_range: 6,
    current_type: "minute",
    interval_unit: "second",
    interval_value: 10,
  },
  {
    current_date_range: 4,
    current_type: "minute",
    interval_unit: "second",
    interval_value: 5,
  },
  {
    current_date_range: 1,
    current_type: "minute",
    interval_unit: "second",
    interval_value: 1,
  },
];

export const CAN_SEARCH_FIELD_TYPE = ["STRING", "ARRAY", "NUMBER", "VARIANT"];
export const ENABLE_SEARCH_FIELD_TYPE = ["DATETIME", "TIMESTAMP", "TIME"];

export function getAutoInterval(currentDate: [Dayjs, Dayjs]): AutoInterval {
  const AUTO_INTERVALS_OBJ = groupBy(
    AUTO_INTERVALS,
    ({ current_type }) => current_type,
  );
  const [startDate, endDate] = currentDate;
  const diffYear = endDate?.diff(startDate, "year");
  const diffMonth = endDate?.diff(startDate, "month");
  const diffWeek = endDate?.diff(startDate, "week");
  const diffDay = endDate?.diff(startDate, "day");
  const diffHour = endDate?.diff(startDate, "hour");
  const diffMinute = endDate?.diff(startDate, "minute");

  let intervalInfo: any = {};

  if ((diffYear as number) >= 3) {
    intervalInfo = AUTO_INTERVALS_OBJ["year"].find((item) => {
      return item.current_date_range === 3;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffYear as number) < 3 && (diffYear as number) >= 1) {
    intervalInfo = AUTO_INTERVALS_OBJ["year"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffMonth as number) >= 1) {
    intervalInfo = AUTO_INTERVALS_OBJ["month"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffWeek as number) >= 1) {
    intervalInfo = AUTO_INTERVALS_OBJ["week"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffDay as number) >= 4) {
    intervalInfo = AUTO_INTERVALS_OBJ["day"].find((item) => {
      return item.current_date_range === 4;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffDay as number) >= 1 && (diffDay as number) < 4) {
    intervalInfo = AUTO_INTERVALS_OBJ["day"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffHour as number) >= 16) {
    intervalInfo = AUTO_INTERVALS_OBJ["hour"].find((item) => {
      return item.current_date_range === 16;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffHour as number) >= 8) {
    intervalInfo = AUTO_INTERVALS_OBJ["hour"].find((item) => {
      return item.current_date_range === 8;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffHour as number) >= 2) {
    intervalInfo = AUTO_INTERVALS_OBJ["hour"].find((item) => {
      return item.current_date_range === 2;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffMinute as number) >= 38) {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 38;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffMinute as number) >= 13) {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 13;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffMinute as number) >= 6) {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 6;
    });
    return intervalInfo as AutoInterval;
  }

  if ((diffMinute as number) >= 4) {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 4;
    });
    return intervalInfo as AutoInterval;
  }
  if ((diffMinute as number) >= 1) {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  } else {
    intervalInfo = AUTO_INTERVALS_OBJ["minute"].find((item) => {
      return item.current_date_range === 1;
    });
    return intervalInfo as AutoInterval;
  }
}

export function translationDateIntervalType(type: IntervalEnum): string {
  if (type === "auto") {
    return "Auto";
  } else if (type === "second") {
    return "Second";
  } else if (type === "minute") {
    return "Minute";
  } else if (type === "hour") {
    return "Hour";
  } else if (type === "day") {
    return "Day";
  } else if (type === "week") {
    return "Week";
  } else if (type === "month") {
    return "Month";
  }

  return "Year";
}
