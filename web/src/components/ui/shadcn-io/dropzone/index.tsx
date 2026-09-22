"use client";

import { UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { DropEvent, DropzoneOptions, FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { Button } from "@/src/components/ui/button";
import { cn } from "@/src/utils/tailwind";

import { useTranslation } from "react-i18next";
type DropzoneContextType = {
  src?: File[];
  accept?: DropzoneOptions["accept"];
  maxSize?: DropzoneOptions["maxSize"];
  minSize?: DropzoneOptions["minSize"];
  maxFiles?: DropzoneOptions["maxFiles"];
};

const renderBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)}${units[unitIndex]}`;
};

const DropzoneContext = createContext<DropzoneContextType | undefined>(
  undefined,
);

export type DropzoneProps = Omit<DropzoneOptions, "onDrop"> & {
  src?: File[];
  className?: string;
  onDrop?: (
    acceptedFiles: File[],
    fileRejections: FileRejection[],
    event: DropEvent,
  ) => void;
  children?: ReactNode;
};

export const Dropzone = ({
  accept,
  maxFiles = 1,
  maxSize,
  minSize,
  onDrop,
  onError,
  disabled,
  src,
  className,
  children,
  ...props
}: DropzoneProps) => {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept,
    maxFiles,
    maxSize,
    minSize,
    onError,
    disabled,
    onDrop: (acceptedFiles, fileRejections, event) => {
      if (fileRejections.length > 0) {
        const message = fileRejections.at(0)?.errors.at(0)?.message;
        onError?.(new Error(message));
        return;
      }

      onDrop?.(acceptedFiles, fileRejections, event);
    },
    ...props,
  });

  return (
    <DropzoneContext.Provider
      key={JSON.stringify(src)}
      value={{ src, accept, maxSize, minSize, maxFiles }}
    >
      <Button
        className={cn(
          "relative h-auto w-full flex-col overflow-hidden p-8",
          isDragActive && "ring-ring ring-1 outline-hidden",
          className,
        )}
        disabled={disabled}
        type="button"
        variant="outline"
        {...getRootProps()}
      >
        <input {...getInputProps()} disabled={disabled} />
        {children}
      </Button>
    </DropzoneContext.Provider>
  );
};

const useDropzoneContext = () => {
  const context = useContext(DropzoneContext);

  if (!context) {
    throw new Error("useDropzoneContext must be used within a Dropzone");
  }

  return context;
};

export type DropzoneContentProps = {
  children?: ReactNode;
  className?: string;
};

const maxLabelItems = 3;

export const DropzoneContent = ({
  children,
  className,
}: DropzoneContentProps) => {
  const { t, i18n } = useTranslation();
  const { src } = useDropzoneContext();

  if (!src) {
    return null;
  }

  if (children) {
    return children;
  }

  return (
    <div className={cn("flex flex-col items-center justify-center", className)}>
      <div className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
        <UploadIcon size={16} />
      </div>
      <p className="my-2 w-full truncate text-sm font-medium">
        {src.length > maxLabelItems
          ? t("{{list}} and {{count}} more", {
              list: new Intl.ListFormat(i18n.language).format(
                src.slice(0, maxLabelItems).map((file) => file.name),
              ),
              count: src.length - maxLabelItems,
            })
          : new Intl.ListFormat(i18n.language).format(
              src.map((file) => file.name),
            )}
      </p>
      <p className="text-muted-foreground w-full text-xs text-wrap">
        {t("Drag and drop or click to replace")}
      </p>
    </div>
  );
};

export type DropzoneEmptyStateProps = {
  children?: ReactNode;
  className?: string;
};

export const DropzoneEmptyState = ({
  children,
  className,
}: DropzoneEmptyStateProps) => {
  const { t, i18n } = useTranslation();
  const { src, accept, maxSize, minSize, maxFiles } = useDropzoneContext();

  if (src) {
    return null;
  }

  if (children) {
    return children;
  }

  // Each clause is a whole sentence so that translations are not assembled
  // from fragments, which reorder differently per language.
  const captionParts: string[] = [];

  if (accept) {
    captionParts.push(
      t("Accepts {{list}}.", {
        list: new Intl.ListFormat(i18n.language).format(Object.keys(accept)),
      }),
    );
  }

  if (minSize && maxSize) {
    captionParts.push(
      t("Size between {{min}} and {{max}}.", {
        min: renderBytes(minSize),
        max: renderBytes(maxSize),
      }),
    );
  } else if (minSize) {
    captionParts.push(
      t("Size at least {{min}}.", { min: renderBytes(minSize) }),
    );
  } else if (maxSize) {
    captionParts.push(
      t("Size less than {{max}}.", { max: renderBytes(maxSize) }),
    );
  }

  const caption = captionParts.join(" ");

  return (
    <div className={cn("flex flex-col items-center justify-center", className)}>
      <div className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
        <UploadIcon size={16} />
      </div>
      <p className="my-2 w-full truncate text-sm font-medium text-wrap">
        {maxFiles === 1 ? t("Upload a file") : t("Upload files")}
      </p>
      <p className="text-muted-foreground w-full truncate text-xs text-wrap">
        {t("Drag and drop or click to upload")}
      </p>
      {caption && (
        <p className="text-muted-foreground text-xs text-wrap">{caption}</p>
      )}
    </div>
  );
};
