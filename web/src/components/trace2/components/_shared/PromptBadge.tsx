import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/src/components/ui/badge";
import { api } from "@/src/utils/api";

import { useTranslation } from "react-i18next";
export const PromptBadge = (props: { promptId: string; projectId: string }) => {
  const { t } = useTranslation();
  const prompt = api.prompts.byId.useQuery({
    id: props.promptId,
    projectId: props.projectId,
  });

  if (prompt.isLoading || !prompt.data) return null;

  return (
    <Link
      href={`/project/${props.projectId}/prompts/${encodeURIComponent(prompt.data.name)}?version=${prompt.data.version}`}
      className="inline-flex"
    >
      <Badge variant="tertiary">
        <span className="truncate">
          {t("Prompt: {{name}} - v{{version}}", {
            name: prompt.data.name,
            version: prompt.data.version,
          })}
        </span>
        <ExternalLinkIcon className="ml-1 h-3 w-3" />
      </Badge>
    </Link>
  );
};
