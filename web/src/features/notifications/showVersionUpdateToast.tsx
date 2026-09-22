import { Button } from "@/src/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

/**
 * Rendered as a component rather than inline JSX so that it runs inside the
 * React tree and can use the translation hook.
 */
const VersionUpdateNotification = () => {
  const { t } = useTranslation();
  return (
    <div className="flex justify-between">
      <div className="flex min-w-[300px] flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="text-foreground/70 m-0 text-sm leading-tight font-medium">
            {t(
              "We have released a new version of Litefuse. Please refresh your browser to get the latest update.",
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size={"sm"}
          className="text-foreground/50"
          onClick={() => {
            window.location.reload();
          }}
        >
          {t("Refresh page")}
        </Button>
      </div>
    </div>
  );
};

export const showVersionUpdateToast = () => {
  toast.custom(() => <VersionUpdateNotification />, {
    duration: Infinity,
    style: {
      padding: "1rem",
      borderRadius: "0.5rem",
      border: "1px solid hsl(var(--border))",
      backgroundColor: "hsl(var(--border))",
    },
  });
};
