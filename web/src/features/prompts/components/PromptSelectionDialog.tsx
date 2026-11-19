import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogBody,
} from "@/src/components/ui/dialog";
import { Button } from "@/src/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { Label } from "@/src/components/ui/label";
import { api } from "@/src/utils/api";
import { CopyIcon, ExternalLinkIcon, CheckIcon } from "lucide-react";
import { copyTextToClipboard } from "@/src/utils/clipboard";

import { useTranslation } from "react-i18next";
type PromptSelectionDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect?: (tag: string) => void;
  projectId: string;
};

export function PromptSelectionDialog({
  isOpen,
  onClose,
  onSelect,
  projectId,
}: PromptSelectionDialogProps) {
  const { t } = useTranslation();
  const [selectedPromptName, setSelectedPromptName] = useState<string>("");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [selectionType, setSelectionType] = useState<"version" | "label">(
    "label",
  );
  const [selectedVersionOrLabel, setSelectedVersionOrLabel] =
    useState<string>("");
  const [copySuccess, setCopySuccess] = useState(false);

  const copySelectedTag = useCallback(async () => {
    try {
      await copyTextToClipboard(selectedTag);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [selectedTag]);

  useEffect(() => {
    if (isOpen) {
      setSelectedPromptName("");
      setSelectedTag("");
      setSelectionType("label");
      setSelectedVersionOrLabel("");
      setCopySuccess(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedPromptName && selectedVersionOrLabel) {
      if (selectionType === "version") {
        setSelectedTag(
          `@@@langfusePrompt:name=${selectedPromptName}|version=${selectedVersionOrLabel}@@@`,
        );
      } else {
        setSelectedTag(
          `@@@langfusePrompt:name=${selectedPromptName}|label=${selectedVersionOrLabel}@@@`,
        );
      }
    } else {
      setSelectedTag("");
    }
  }, [selectedPromptName, selectedVersionOrLabel, selectionType]);

  const { data: promptOptions } = api.prompts.getPromptLinkOptions.useQuery(
    {
      projectId,
    },
    {
      enabled: Boolean(projectId),
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
    },
  );

  const selectedPrompt = promptOptions?.find(
    (option) => option.name === selectedPromptName,
  );

  const handleConfirm = useCallback(async () => {
    if (!selectedTag) return;
    if (onSelect) {
      onSelect(selectedTag);
    } else {
      await copyTextToClipboard(selectedTag);
    }
    onClose();
  }, [selectedTag, onSelect, onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Add inline prompt reference")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              {t(
                "Referenced prompts are dynamically resolved and inserted when fetched via API/SDK. This enables modular design—create complex prompts from reusable, independently maintained components.",
              )}
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="prompt-name">{t("Prompt name")}</Label>
              <Select
                value={selectedPromptName}
                onValueChange={(value) => {
                  setSelectedPromptName(value);
                  setSelectedVersionOrLabel("");
                }}
              >
                <SelectTrigger id="prompt-name">
                  <SelectValue placeholder={t("Select a text prompt")} />
                </SelectTrigger>
                <SelectContent>
                  {promptOptions?.map((prompt) => (
                    <SelectItem key={prompt.name} value={prompt.name}>
                      {prompt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {t("Only text prompts can be referenced inline.")}
              </p>
            </div>

            {selectedPromptName && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="selection-type">{t("Reference by")}</Label>
                <Select
                  value={selectionType}
                  onValueChange={(value: "version" | "label") => {
                    setSelectionType(value);
                    setSelectedVersionOrLabel("");
                  }}
                >
                  <SelectTrigger id="selection-type">
                    <SelectValue placeholder={t("Select link type")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="label">{t("Label")}</SelectItem>
                    <SelectItem value="version">{t("Version")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedPromptName && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="version-or-label">
                  {selectionType === "version" ? t("Version") : t("Label")}
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={selectedVersionOrLabel}
                    onValueChange={setSelectedVersionOrLabel}
                  >
                    <SelectTrigger id="version-or-label">
                      <SelectValue
                        placeholder={
                          selectionType === "version"
                            ? t("Select a version")
                            : t("Select a label")
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {selectionType === "version"
                        ? selectedPrompt?.versions.map((version) => (
                            <SelectItem
                              key={version.toString()}
                              value={version.toString()}
                            >
                              {version}
                            </SelectItem>
                          ))
                        : selectedPrompt?.labels.map((label) => (
                            <SelectItem key={label} value={label}>
                              {label}
                            </SelectItem>
                          ))}
                    </SelectContent>
                  </Select>
                  {selectedVersionOrLabel && (
                    <Link
                      href={`/project/${projectId}/prompts/${selectedPromptName}?${selectionType}=${selectedVersionOrLabel}`}
                      target="_blank"
                      passHref
                    >
                      <Button type="button" variant="outline" size="icon">
                        <ExternalLinkIcon className="h-4 w-4" />
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>

          {selectedTag && (
            <div className="space-y-2">
              <Label>{t("Tag preview")}</Label>
              <div className="relative">
                <div className="bg-muted rounded-md border p-3 pr-10 font-mono text-xs">
                  {selectedTag}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="bg-opacity-70 absolute top-2 right-2"
                  onClick={copySelectedTag}
                >
                  {copySuccess ? (
                    <CheckIcon className="h-4 w-4 text-green-500" />
                  ) : (
                    <CopyIcon className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {onSelect
                  ? t("This tag will be inserted into the prompt content.")
                  : t(
                      "This tag will be copied to clipboard to be then inserted into the prompt",
                    )}
              </p>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={!selectedTag}>
            {onSelect ? t("Insert") : t("Copy and close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
