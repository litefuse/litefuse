import { ActionButton } from "@/src/components/ActionButton";
import { BadgeCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export type SuccessNotificationProps = {
  title: string;
  description: string;
  onDismiss: () => void;
  link?: {
    href: string;
    text: string;
  };
};

export const SuccessNotification: React.FC<SuccessNotificationProps> = ({
  title,
  description,
  onDismiss,
  link,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex justify-between">
      <div className="flex min-w-[300px] flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <BadgeCheck size={20} className="text-primary-foreground" />
          <div className="text-primary-foreground m-0 text-sm leading-tight font-medium">
            {title}
          </div>
        </div>
        {description && (
          <div className="text-primary-foreground text-sm leading-tight">
            {description}
          </div>
        )}
        {link && (
          <ActionButton
            href={link.href}
            size="sm"
            variant="secondary"
            className="self-start"
          >
            {t(link.text)}
          </ActionButton>
        )}
      </div>
      <button
        className="text-primary-foreground flex h-6 w-6 cursor-pointer items-start justify-end border-none bg-transparent p-0 transition-colors duration-200"
        onClick={onDismiss}
        aria-label={t("Close")}
      >
        <X size={14} />
      </button>
    </div>
  );
};
