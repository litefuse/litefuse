import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/src/components/ui/dropdown-menu";
import { Button } from "@/src/components/ui/button";
import { Download, Loader, Info } from "lucide-react";
import {
  type BatchExportTableName,
  exportOptions,
  type BatchExportFileFormat,
  type OrderByState,
  BatchTableNames,
} from "@langfuse/shared";
import React from "react";
import { api } from "@/src/utils/api";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { copyTextToClipboard } from "@/src/utils/clipboard";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/src/components/ui/alert-dialog";
import { Textarea } from "@/src/components/ui/textarea";

export type BatchExportTableButtonProps = {
  projectId: string;
  tableName: BatchExportTableName;
  orderByState: OrderByState;
  filterState: any;
  searchQuery?: any;
  searchType?: any;
};

export const BatchExportTableButton: React.FC<BatchExportTableButtonProps> = (
  props,
) => {
  const [isExporting, setIsExporting] = React.useState(false);
  const [apiWarning, setApiWarning] = React.useState<{
    downloadUrl: string;
    curlCommand: string;
    estimatedFileSizeBytes: number;
  } | null>(null);
  const createExport = api.batchExport.create.useMutation({
    onSettled: () => {
      setIsExporting(false);
    },
  });
  const hasAccess = useHasProjectAccess({
    projectId: props.projectId,
    scope: "batchExports:create",
  });

  const formatFileSize = (bytes: number) => {
    const gb = 1024 * 1024 * 1024;
    const mb = 1024 * 1024;

    if (bytes >= gb) {
      return `${(bytes / gb).toFixed(2)} GB`;
    }

    return `${(bytes / mb).toFixed(2)} MB`;
  };

  const sanitizeExportFileName = (fileName: string) =>
    fileName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim();

  const handleExport = async (format: BatchExportFileFormat) => {
    setIsExporting(true);
    const exportName = `${new Date().toISOString()} - ${props.tableName} as ${format}`;
    const result = await createExport.mutateAsync({
      projectId: props.projectId,
      name: exportName,
      format,
      query: {
        tableName: props.tableName,
        filter: props.filterState,
        searchQuery: props.searchQuery || undefined,
        searchType: props.searchType || undefined,
        orderBy: props.orderByState,
      },
    });

    const downloadUrl = new URL(
      result.downloadPath,
      window.location.origin,
    ).toString();
    const fileName = sanitizeExportFileName(
      `${exportName}.${exportOptions[format].extension}`,
    );
    const curlCommand = `curl -L "${downloadUrl}" -o "${fileName}"`;

    if (result.mode === "browser_download") {
      showSuccessToast({
        title: "Download starting",
        description: `Estimated export size: ${formatFileSize(result.estimatedFileSizeBytes)}.`,
      });
      window.location.assign(result.downloadPath);
      return;
    }

    setApiWarning({
      downloadUrl,
      curlCommand,
      estimatedFileSizeBytes: result.estimatedFileSizeBytes,
    });
  };

  if (!hasAccess) return null;

  const getWarningMessage = () => {
    switch (props.tableName) {
      case BatchTableNames.Traces:
        return "Note: Filters on observation-level columns (Level, Tokens, Cost, Latency) and Comments are not included in trace exports. You may receive more data than expected.";
      case BatchTableNames.Observations:
        return "Note: Filters on trace-level columns (Trace Name, Trace Tags, User ID, Trace Environment) and Comments are not included in observation exports. You may receive more data than expected.";
      case BatchTableNames.Events:
        return "Note: Filters on Comments are not included in event exports. You may receive more data than expected.";
      case BatchTableNames.Sessions:
        return "Note: Filters on Comments are not included in session exports. You may receive more data than expected.";
      case BatchTableNames.AuditLogs:
        return "Note: Filters are not applied to audit log exports. All audit logs for this project will be exported.";
      default:
        // Note: for Scores, DatasetRunItems, DatasetItems, filters should work as expected
        return null;
    }
  };

  const warningMessage = getWarningMessage();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" title="Export">
            {isExporting ? (
              <Loader className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className="w-80">
            <DropdownMenuLabel>Export</DropdownMenuLabel>
            {warningMessage && (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                <div className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{warningMessage}</span>
                </div>
              </div>
            )}
            <DropdownMenuSeparator />
            {Object.entries(exportOptions).map(([key, options]) => (
              <DropdownMenuItem
                key={key}
                className="capitalize"
                onClick={() => void handleExport(key as BatchExportFileFormat)}
              >
                as {options.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>

      <AlertDialog
        open={Boolean(apiWarning)}
        onOpenChange={(open) => {
          if (!open) {
            setApiWarning(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Export Too Large For Browser Download
            </AlertDialogTitle>
            <AlertDialogDescription>
              This export is estimated at{" "}
              {apiWarning
                ? formatFileSize(apiWarning.estimatedFileSizeBytes)
                : "-"}
              . Browser download is limited to files smaller than 1 GB. Use the
              download API below instead.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <div className="text-sm font-medium">Signed download URL</div>
              <Textarea
                readOnly
                value={apiWarning?.downloadUrl ?? ""}
                className="min-h-[96px] font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!apiWarning) return;
                  void copyTextToClipboard(apiWarning.downloadUrl);
                  showSuccessToast({
                    title: "Download URL copied",
                    description:
                      "The signed batch export URL is in your clipboard.",
                  });
                }}
              >
                Copy URL
              </Button>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Example cURL command</div>
              <Textarea
                readOnly
                value={apiWarning?.curlCommand ?? ""}
                className="min-h-[120px] font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!apiWarning) return;
                  void copyTextToClipboard(apiWarning.curlCommand);
                  showSuccessToast({
                    title: "cURL command copied",
                    description:
                      "The batch export API command is in your clipboard.",
                  });
                }}
              >
                Copy cURL
              </Button>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!apiWarning) return;
                window.open(
                  apiWarning.downloadUrl,
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              Open API URL
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
