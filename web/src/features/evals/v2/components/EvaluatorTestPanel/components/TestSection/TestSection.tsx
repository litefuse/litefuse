import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SectionHeader } from "@/src/features/evals/v2/components/Evaluators/Testing/components/SectionHeader/SectionHeader";

export function TestSection({ content }: { content: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="flex shrink-0 flex-col gap-2">
      <SectionHeader
        title={t("Test the evaluator")}
        meta={null}
        description={null}
        tooltip={t(
          "Run the evaluator against the selected observation to check that it scores the way you'd expect.",
        )}
        trailing={null}
      />
      {content}
    </section>
  );
}
