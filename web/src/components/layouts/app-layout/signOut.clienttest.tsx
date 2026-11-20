import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { type Session } from "next-auth";
import { AppLayout } from "./index";

const mockReplace = jest.fn();
const mockRouter = {
  pathname: "/project/test",
  asPath: "/project/test",
  query: {},
  replace: mockReplace,
};
jest.mock("next/router", () => ({ useRouter: () => mockRouter }));
jest.mock("../../../env.mjs", () => ({ env: {} }));
jest.mock("../../../features/projects/hooks", () => ({
  useQueryProjectOrOrganization: () => ({}),
}));
jest.mock("./hooks/useLayoutConfiguration", () => ({
  useLayoutConfiguration: () => ({
    variant: "authenticated",
    hideNavigation: false,
    isPublishable: false,
  }),
}));
jest.mock("./hooks/useProjectAccess", () => ({
  useProjectAccess: () => ({ hasAccess: true }),
}));
jest.mock("./hooks/useFilteredNavigation", () => ({
  useFilteredNavigation: () => ({ navigation: [] }),
}));
jest.mock("./hooks/useLayoutMetadata", () => ({
  useLayoutMetadata: () => ({}),
}));
jest.mock("posthog-js", () => ({ reset: jest.fn() }));
jest.mock("../../../components/error-page", () => ({
  ErrorPageWithSentry: () => null,
}));
jest.mock("./variants/UnauthenticatedLayout", () => ({
  UnauthenticatedLayout: () => null,
}));
jest.mock("./variants/MinimalLayout", () => ({ MinimalLayout: () => null }));
jest.mock("./variants/LoadingLayout", () => ({
  LoadingLayout: () => <div>Loading</div>,
}));
jest.mock("./variants/AuthenticatedLayout", () => ({
  AuthenticatedLayout: ({ onSignOut }: { onSignOut: () => void }) => (
    <button onClick={onSignOut}>Sign out</button>
  ),
}));

const originalFetch = global.fetch;
const initialSession = {
  user: { id: "user-1", email: "user@example.com" },
  expires: "2099-01-01T00:00:00Z",
} as Session;

describe("AppLayout sign-out navigation with the real NextAuth client", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it.each([true, false])(
    "does not let the guard replace the logout destination after NextAuth clears the session (IdP preparation succeeds: %s)",
    async (prepareSucceeds) => {
      let currentSession: Session | null = initialSession;
      let refreshedAfterLogout = 0;
      global.fetch = jest.fn(async (input, init) => {
        const path = String(input);
        let data: unknown;
        if (path.endsWith("/sso-logout"))
          return {
            ok: prepareSucceeds,
            json: async () => ({ url: "https://idp.example.com/logout" }),
          } as Response;
        if (path.endsWith("/csrf")) data = { csrfToken: "test-csrf" };
        if (path.endsWith("/signout")) {
          currentSession = null;
          data = {
            url: `http://localhost${new URLSearchParams(String(init?.body)).get("callbackUrl")}`,
          };
        }
        if (path.endsWith("/session")) {
          data = currentSession;
          if (!currentSession) refreshedAfterLogout++;
        }
        return { ok: true, json: async () => data } as Response;
      });
      // jsdom reports cross-document navigation as unsupported; keep the old page mounted,
      // which models the interval while a slow IdP has not committed its response yet.
      const navigationError = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        render(
          <SessionProvider
            session={initialSession}
            refetchOnWindowFocus={false}
          >
            <AppLayout>Content</AppLayout>
          </SessionProvider>,
        );
        fireEvent.click(screen.getByText("Sign out"));
        await waitFor(() => expect(refreshedAfterLogout).toBeGreaterThan(0));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(mockReplace).not.toHaveBeenCalled();
        expect(refreshedAfterLogout).toBe(1);
      } finally {
        navigationError.mockRestore();
      }
    },
  );
});
