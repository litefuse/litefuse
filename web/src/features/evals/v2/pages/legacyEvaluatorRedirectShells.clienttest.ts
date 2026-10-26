/**
 * LITEFUSE ADDITION (D6).
 *
 * `/evals/templates`, `/evals/configs` and `/evals/default-model` are the three
 * legacy (v1) evaluator bookmarks that used to fall through to the dynamic
 * `/evals/[evaluatorId]` route and 404. Each now has a static redirect shell
 * pointing at the same page under `/evals/legacy/**`; this pins the shell
 * contract (307 via `permanent: false`, project id encoded, query preserved) so
 * it survives without needing a rebuilt server to check it.
 */
import type { GetServerSidePropsContext } from "next";

import { getServerSideProps as configsGetServerSideProps } from "@/src/pages/project/[projectId]/evals/configs";
import { getServerSideProps as defaultModelGetServerSideProps } from "@/src/pages/project/[projectId]/evals/default-model";
import { getServerSideProps as templatesGetServerSideProps } from "@/src/pages/project/[projectId]/evals/templates";

// The shells only read `params.projectId` and `resolvedUrl`, so a partial stub is
// enough here; the double assertion keeps the fixture honest without pretending to
// implement the whole Next request/response surface.
const context = (resolvedUrl: string, projectId = "jevdemoproject01") =>
  ({ params: { projectId }, resolvedUrl }) as unknown as GetServerSidePropsContext;

describe("legacy evaluator redirect shells", () => {
  it.each([
    [
      "templates",
      templatesGetServerSideProps,
      "/project/jevdemoproject01/evals/templates",
      "/project/jevdemoproject01/evals/legacy/templates",
    ],
    [
      "configs",
      configsGetServerSideProps,
      "/project/jevdemoproject01/evals/configs",
      "/project/jevdemoproject01/evals/legacy/configs",
    ],
    [
      "default-model",
      defaultModelGetServerSideProps,
      "/project/jevdemoproject01/evals/default-model",
      "/project/jevdemoproject01/evals/legacy/default-model",
    ],
  ])(
    "/evals/%s redirects to its legacy page with a temporary redirect",
    async (_name, getServerSideProps, resolvedUrl, destination) => {
      await expect(
        getServerSideProps(context(resolvedUrl)),
      ).resolves.toEqual({
        redirect: { destination, permanent: false },
      });
    },
  );

  it("preserves the query string and encodes the project id", async () => {
    await expect(
      templatesGetServerSideProps(
        context("/project/jev demo/evals/templates?page=2&search=judge", "jev demo"),
      ),
    ).resolves.toEqual({
      redirect: {
        destination:
          "/project/jev%20demo/evals/legacy/templates?page=2&search=judge",
        permanent: false,
      },
    });
  });
});
