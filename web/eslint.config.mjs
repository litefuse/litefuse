import nextConfig from "@repo/eslint-config/next";
import { tableRoutingRule } from "@repo/eslint-config/base";
import { i18nRuleBlock } from "./eslint.i18n.rules.mjs";

export default [
  ...nextConfig,

  // Table-split guard: no bare spans/traces_scalar SQL literals in the
  // query-building layer (Stage 0.7 — route through tableFor/sharedTableFor).
  tableRoutingRule([
    "src/features/**/*.ts",
    "src/pages/api/**/*.ts",
    "src/server/**/*.ts",
  ]),

  i18nRuleBlock,

  // Restrict react-icons imports
  {
    name: "langfuse/web/react-icons-restriction",
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react-icons",
                "react-icons/!(si|tb)",
                "react-icons/!(si|tb)/*",
              ],
              message:
                "Only react-icons/si and react-icons/tb are allowed. Please use lucide-react for other icons.",
            },
          ],
        },
      ],
    },
  },

  // Exceptions for specific files
  {
    name: "langfuse/web/react-icons-exceptions",
    files: [
      "src/components/nav/support-menu-dropdown.tsx",
      "src/pages/auth/sign-in.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
