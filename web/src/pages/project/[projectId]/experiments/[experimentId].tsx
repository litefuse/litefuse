import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { api } from "@/src/utils/api";
import { Button } from "@/src/components/ui/button";
import { JSONView } from "@/src/components/ui/CodeJsonViewer";
import { DatasetRunItemsByRunTable } from "@/src/features/datasets/components/DatasetRunItemsByRunTable";
import { DeleteDatasetRunButton } from "@/src/features/datasets/components/DeleteDatasetRunButton";
import { DetailPageNav } from "@/src/features/navigate-detail-pages/DetailPageNav";
import { Columns3, MoreVertical } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/src/components/ui/dropdown-menu";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelTitle,
} from "@/src/components/ui/side-panel";
import { Skeleton } from "@/src/components/ui/skeleton";
import { LocalIsoDate } from "@/src/components/LocalIsoDate";

export default function ExperimentDetail() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const experimentId = router.query.experimentId as string;
  const run = api.experiments.runById.useQuery(
    {
      projectId,
      runId: experimentId,
    },
    {
      enabled: Boolean(projectId && experimentId),
    },
  );

  const datasetId = run.data?.datasetId;

  return (
    <Page
      headerProps={{
        title: run.data?.name ?? experimentId,
        itemType: "DATASET_RUN",
        breadcrumb: [
          { name: "Experiments", href: `/project/${projectId}/experiments` },
          ...(run.data?.dataset
            ? [
                {
                  name: run.data.dataset.name,
                  href: `/project/${projectId}/datasets/${run.data.dataset.id}`,
                },
              ]
            : []),
        ],
        help: {
          description:
            "View and analyze a specific experiment run. See docs to learn more.",
          href: "https://litefuse.ai/docs/datasets/experiments",
        },
        actionButtonsRight: datasetId ? (
          <>
            <Link
              href={{
                pathname: `/project/${projectId}/datasets/${datasetId}/compare`,
                query: { runs: [experimentId] },
              }}
            >
              <Button>
                <Columns3 className="mr-2 h-4 w-4" />
                <span>Compare</span>
              </Button>
            </Link>
            <DetailPageNav
              currentId={experimentId}
              path={(entry) => `/project/${projectId}/experiments/${entry.id}`}
              listKey="experiments"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem asChild>
                  <DeleteDatasetRunButton
                    projectId={projectId}
                    datasetRunId={experimentId}
                    datasetId={datasetId}
                    redirectUrl={`/project/${projectId}/experiments`}
                  />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null,
      }}
    >
      <div className="grid flex-1 grid-cols-[1fr_auto] overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          {run.isPending ? (
            <Skeleton className="m-4 h-40 w-[calc(100%-2rem)]" />
          ) : datasetId ? (
            <DatasetRunItemsByRunTable
              projectId={projectId}
              datasetId={datasetId}
              datasetRunId={experimentId}
              datasetVersion={run.data?.datasetVersion}
            />
          ) : (
            <div className="text-muted-foreground p-4 text-sm">
              Experiment run not found.
            </div>
          )}
        </div>
        <SidePanel
          mobileTitle="Experiment run details"
          id="experiment-run-details"
        >
          <SidePanelHeader>
            <SidePanelTitle>Experiment run details</SidePanelTitle>
          </SidePanelHeader>
          <SidePanelContent>
            {run.isPending ? (
              <Skeleton className="h-full w-full" />
            ) : run.data ? (
              <>
                {run.data.datasetVersion && (
                  <div className="flex flex-col gap-2 p-1">
                    <span className="text-sm font-medium">Dataset Version</span>
                    <Link
                      href={`/project/${projectId}/datasets/${run.data.datasetId}/items?version=${run.data.datasetVersion.toISOString()}`}
                      className="text-accent-dark-blue hover:text-primary-accent/60 text-sm"
                    >
                      <LocalIsoDate date={run.data.datasetVersion} />
                    </Link>
                  </div>
                )}
                {!!run.data.description && (
                  <JSONView json={run.data.description} title="Description" />
                )}
                {!!run.data.metadata && (
                  <JSONView json={run.data.metadata} title="Metadata" />
                )}
              </>
            ) : (
              <div className="text-muted-foreground p-1 text-sm">
                Experiment run not found.
              </div>
            )}
          </SidePanelContent>
        </SidePanel>
      </div>
    </Page>
  );
}
