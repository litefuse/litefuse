import { filterOperators } from "../../../interfaces/filters";
import { Filter, DbFilter } from "../filter";

export class StringFilter implements Filter {
  public table: string;
  public field: string;
  public value: string;
  public operator: (typeof filterOperators)["string"][number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["string"][number];
    value: string;
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    // 转义单引号以防止SQL注入
    const escapedValue = this.value.replace(/'/g, "''");

    let query: string;
    switch (this.operator) {
      case "=":
        // 精确匹配使用等号，可以利用索引
        query = `${fieldWithPrefix} = '${escapedValue}'`;
        break;
      case "contains":
        // 包含操作，优先使用INSTR函数，性能比LIKE更好
        query = `INSTR(${fieldWithPrefix}, '${escapedValue}') > 0`;
        break;
      case "does not contain":
        // 不包含操作
        query = `INSTR(${fieldWithPrefix}, '${escapedValue}') = 0`;
        break;
      case "starts with":
        // 开始于操作，使用STARTS_WITH函数
        query = `STARTS_WITH(${fieldWithPrefix}, '${escapedValue}')`;
        break;
      case "ends with":
        // 结束于操作，使用ENDS_WITH函数
        query = `ENDS_WITH(${fieldWithPrefix}, '${escapedValue}')`;
        break;
      default:
        throw new Error(`Unsupported operator: ${this.operator}`);
    }

    return {
      query: query,
      params: {}, // Doris 不使用参数化查询，所以 params 为空
    };
  }
}

export class NumberFilter implements Filter {
  public table: string;
  public field: string;
  public value: number;
  public operator: (typeof filterOperators)["number"][number] | "!=";
  public typeOverwrite?: string;
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["number"][number] | "!=";
    value: number;
    tablePrefix?: string;
    typeOverwrite?: string;
    dorisTypeOverwrite?: string; // Backward compatibility alias for typeOverwrite
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
    this.typeOverwrite = opts.typeOverwrite ?? opts.dorisTypeOverwrite;
  }

  apply(): DbFilter {
    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    return {
      query: `${fieldWithPrefix} ${this.operator} ${this.value}`,
      params: {}, // Doris 不使用参数化查询
    };
  }
}

export class DateTimeFilter implements Filter {
  public table: string;
  public field: string;
  public value: Date;
  public operator: (typeof filterOperators)["datetime"][number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["datetime"][number];
    value: Date;
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    // 将Date对象转换为Doris DateTime(3)格式的字符串
    // const dateTimeString = this.value.toISOString().replace('T', ' ').replace('Z', '');
    // Doris stores UTC timestamps, convert Date to UTC string
    const dateTimeString = this.value
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");

    return {
      query: `${fieldWithPrefix} ${this.operator} '${dateTimeString}'`,
      params: {}, // Doris 不使用参数化查询
    };
  }
}

export class StringOptionsFilter implements Filter {
  public table: string;
  public field: string;
  public values: string[];
  public operator: (typeof filterOperators.stringOptions)[number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators.stringOptions)[number];
    values: string[];
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.values = opts.values;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    if (this.values.length === 0) {
      return {
        query: this.operator === "any of" ? "1=0" : "1=1",
        params: {},
      };
    }

    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    // Escape single quotes in values
    const escapedValues = this.values.map(
      (value) => `'${value.replace(/'/g, "''")}'`,
    );
    const valuesList = escapedValues.join(", ");

    const query =
      this.operator === "any of"
        ? `${fieldWithPrefix} IN (${valuesList})`
        : `${fieldWithPrefix} NOT IN (${valuesList})`;

    return {
      query,
      params: {},
    };
  }
}

export class BooleanFilter implements Filter {
  public table: string;
  public field: string;
  public operator: (typeof filterOperators)["boolean"][number];
  public value: boolean;
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["boolean"][number];
    value: boolean;
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    return {
      query: `${fieldWithPrefix} ${this.operator} ${this.value ? "TRUE" : "FALSE"}`,
      params: {}, // Doris 不使用参数化查询
    };
  }
}

export class NullFilter implements Filter {
  public table: string;
  public field: string;
  public operator: (typeof filterOperators)["null"][number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["null"][number];
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    return {
      query: `${fieldWithPrefix} ${this.operator}`,
      params: {},
    };
  }
}

export class ArrayOptionsFilter implements Filter {
  public table: string;
  public field: string;
  public values: string[];
  public operator: (typeof filterOperators.arrayOptions)[number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators.arrayOptions)[number];
    values: string[];
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.values = opts.values;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    // Empty values: "any of" nothing → always false; "none of" / "all of" nothing → always true
    if (this.values.length === 0) {
      return {
        query: this.operator === "any of" ? "1=0" : "1=1",
        params: {},
      };
    }

    const fieldWithPrefix = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    // Escape single quotes in values
    const escapedValues = this.values.map(
      (value) => `'${value.replace(/'/g, "''")}'`,
    );

    let query: string;
    switch (this.operator) {
      case "any of":
        // Use arrays_overlap with array() function syntax for Doris
        query = `arrays_overlap(${fieldWithPrefix}, array(${escapedValues.join(", ")}))`;
        break;
      case "none of":
        // Check array does not contain any of the specified values
        query = `NOT arrays_overlap(${fieldWithPrefix}, array(${escapedValues.join(", ")}))`;
        break;
      case "all of":
        // Check array contains all specified values
        const allChecks = escapedValues
          .map((value) => `array_contains(${fieldWithPrefix}, ${value})`)
          .join(" AND ");
        query = `(${allChecks})`;
        break;
      default:
        throw new Error(`Unsupported operator: ${this.operator}`);
    }

    return {
      query,
      params: {},
    };
  }
}

export class CategoryOptionsFilter implements Filter {
  public table: string;
  public field: string;
  public key: string;
  public values: string[];
  public operator: (typeof filterOperators.categoryOptions)[number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators.categoryOptions)[number];
    key: string;
    values: string[];
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.key = opts.key;
    this.values = opts.values;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
  }

  apply(): DbFilter {
    if (this.values.length === 0) {
      return {
        query: this.operator === "any of" ? "1=0" : "1=1",
        params: {},
      };
    }

    // Flatten category values to "key:value" format
    const flattenedValues: string[] = [];
    this.values.forEach((child) => {
      flattenedValues.push(`${this.key}:${child}`);
    });

    const fieldRef = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;

    // Escape values
    const escapedValues = flattenedValues.map(
      (value) => `'${value.replace(/'/g, "''")}'`,
    );
    const valuesList = escapedValues.join(", ");

    switch (this.operator) {
      case "any of":
        // Use arrays_overlap with array() function syntax for Doris
        return {
          query: `arrays_overlap(${fieldRef}, array(${valuesList}))`,
          params: {},
        };
      case "none of":
        // Check array does not contain any of the specified values
        return {
          query: `NOT arrays_overlap(${fieldRef}, array(${valuesList}))`,
          params: {},
        };
      default:
        throw new Error(`Unsupported operator: ${this.operator}`);
    }
  }
}

export class StringObjectFilter implements Filter {
  public table: string;
  public field: string;
  public key: string;
  public value: string;
  public operator: (typeof filterOperators)["stringObject"][number];
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["stringObject"][number];
    key: string;
    value: string;
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
    this.key = opts.key;
  }

  apply(): DbFilter {
    const column = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;
    const escapedKey = this.key.replace(/'/g, "''");
    const escapedValue = this.value.replace(/'/g, "''");

    let query: string;
    switch (this.operator) {
      case "=":
        // 使用 Doris 的 MAP 访问语法
        query = `${column}['${escapedKey}'] = '${escapedValue}'`;
        break;
      case "contains":
        query = `INSTR(${column}['${escapedKey}'], '${escapedValue}') > 0`;
        break;
      case "does not contain":
        query = `INSTR(${column}['${escapedKey}'], '${escapedValue}') = 0`;
        break;
      case "starts with":
        query = `STARTS_WITH(${column}['${escapedKey}'], '${escapedValue}')`;
        break;
      case "ends with":
        query = `ENDS_WITH(${column}['${escapedKey}'], '${escapedValue}')`;
        break;
      default:
        throw new Error(`Unsupported operator: ${this.operator}`);
    }

    return {
      query,
      params: {},
    };
  }
}

export class NumberObjectFilter implements Filter {
  public table: string;
  public field: string;
  public key: string;
  public value: number;
  public operator: (typeof filterOperators)["numberObject"][number] | "!=";
  public tablePrefix?: string;

  constructor(opts: {
    table?: string;
    dorisTable?: string; // Backward compatibility alias for table
    field: string;
    operator: (typeof filterOperators)["numberObject"][number] | "!=";
    key: string;
    value: number;
    tablePrefix?: string;
  }) {
    this.table = opts.table ?? opts.dorisTable ?? "";
    this.field = opts.field;
    this.value = opts.value;
    this.operator = opts.operator;
    this.tablePrefix = opts.tablePrefix;
    this.key = opts.key;
  }

  apply(): DbFilter {
    const column = `${this.tablePrefix ? this.tablePrefix + "." : ""}${this.field}`;
    const escapedKey = this.key.replace(/'/g, "''");

    // Doris version uses struct arrays for scores_avg, matching ClickHouse's
    // Array<Tuple(name, value)> semantics. array_filter iterates over the
    // array and OR-matches: row matches if ANY struct satisfies name=key
    // AND value operator threshold. struct_element(x, N) accesses struct
    // fields positionally (1=name, 2=value), equivalent to CK's x.1 / x.2.
    return {
      query: `size(array_filter(x -> struct_element(x, 1) = '${escapedKey}' AND CAST(struct_element(x, 2) AS DECIMAL(20,6)) ${this.operator} ${this.value}, ${column})) > 0`,
      params: {},
    };
  }
}

// export class FilterList {
//   private filters: Filter[];
//
//   constructor(filters: Filter[] = []) {
//     this.filters = filters;
//   }
//
//   push(...filter: Filter[]) {
//     this.filters.push(...filter);
//   }
//
//   find(predicate: (filter: Filter) => boolean) {
//     return this.filters.find(predicate);
//   }
//
//   filter(predicate: (filter: Filter) => boolean) {
//     return new FilterList(this.filters.filter(predicate));
//   }
//
//   some(predicate: (filter: Filter) => boolean) {
//     return this.filters.some(predicate);
//   }
//
//   forEach(callback: (filter: Filter) => void) {
//     this.filters.forEach(callback);
//   }
//
//   length() {
//     return this.filters.length;
//   }
//
//   public apply(): DbFilter {
//     if (this.filters.length === 0) {
//       return {
//         query: "",
//         params: {},
//       };
//     }
//     const compiledQueries = this.filters.map((filter) => filter.apply());
//     const { params, queries } = compiledQueries.reduce(
//       (acc, { params, query }) => {
//         acc.params = { ...acc.params, ...params };
//         acc.queries.push(query);
//         return acc;
//       },
//       { params: {}, queries: [] as string[] },
//     );
//     return {
//       query: queries.join(" AND "),
//       params,
//     };
//   }
// }
