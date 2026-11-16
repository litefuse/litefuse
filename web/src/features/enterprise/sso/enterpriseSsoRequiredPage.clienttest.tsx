/**
 * Characterisation tests for `web/src/pages/auth/enterprise-sso-required.tsx`
 * (batch 3a, cases H1-H8 of docs/ee-independence/03-auth-sso/spec.md §12.9).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * WHAT IS ASSERTED (and what is deliberately not)
 * The page's contract: which `providerId` is passed to `signIn`, which
 * `callbackUrl` survives the whitelist, what `POST /api/auth/check-sso` carries,
 * which branch wins for a 404 / other status / thrown fetch, and the
 * already-authenticated redirect. Wording of the surrounding copy is free to
 * change, so only the three strings the spec freezes as non-i18n literals (the
 * 404 message, the generic fallback, the catch message) and the two functional
 * strings (the placeholder `jsdoe@example.com`, the rendered provider label) are
 * asserted. `t()` output is not asserted.
 *
 * The page never talks to the network for anything else, so `fetch`,
 * `next/router` and `next-auth/react` are mocked; there is no server involved.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import { signIn, useSession } from "next-auth/react";
import { captureException } from "@sentry/nextjs";

import EnterpriseSsoRequiredPage from "@/src/pages/auth/enterprise-sso-required";

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
  useSession: jest.fn(),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const mockUseRouter = useRouter as unknown as jest.Mock;
const mockUseSession = useSession as unknown as jest.Mock;
const mockSignIn = signIn as unknown as jest.Mock;
const mockCaptureException = captureException as unknown as jest.Mock;

const replace = jest.fn();

/** Router whose query holds only the defined entries. */
const setRouter = (query: Record<string, string> = {}) => {
  mockUseRouter.mockReturnValue({
    query,
    isReady: true,
    asPath: "/auth/enterprise-sso-required",
    replace,
  });
};

const setSession = (status: "authenticated" | "unauthenticated" | "loading") =>
  mockUseSession.mockReturnValue({ status, data: null, update: jest.fn() });

const placeholder = () => screen.getByPlaceholderText("jsdoe@example.com");
const submit = (email: string) => {
  fireEvent.change(placeholder(), { target: { value: email } });
  // Submit the form directly: the submit button's accessible name is translated
  // copy, which these tests deliberately do not pin.
  const form = placeholder().closest("form");
  if (!form) throw new Error("email field is not inside a form");
  fireEvent.submit(form);
};

/**
 * The error paragraph contains the message, a <br> and the support link, so the
 * default "whole node text" matcher cannot see the sentence as one element.
 * Match against the element's full textContent instead, then narrow to the
 * paragraph that holds the message (every ancestor would match too).
 */
const assertErrorText = async (needle: string) => {
  const matches = await screen.findAllByText(
    (_: string, element: Element | null) =>
      element?.textContent?.includes(needle) ?? false,
  );
  const owners = matches.filter((element) =>
    element.className.includes("text-destructive"),
  );
  expect(owners).toHaveLength(1);
  expect(owners[0].textContent).toContain(needle);
};

/** A fetch response stand-in; `jsonBody` may be a value or a thrower. */
const jsonResponse = (status: number, jsonBody: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (jsonBody instanceof Error) throw jsonBody;
    return jsonBody;
  },
});

describe("enterprise-sso-required page (H1-H8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSession("unauthenticated");
    setRouter();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // @ts-expect-error -- restore the environment's fetch
    delete global.fetch;
  });

  // H1
  it("H1 seeds the email field from ?email and keeps the fixed placeholder", () => {
    setRouter({ email: "a@b.com" });
    render(<EnterpriseSsoRequiredPage />);

    expect((placeholder() as HTMLInputElement).value).toBe("a@b.com");
    expect(placeholder().getAttribute("autocomplete")).toBe("email");
    expect(placeholder().getAttribute("name")).toBe("email");
  });

  // H3
  it("H3 renders the friendly provider name for a known id and a hyphen-free fallback otherwise", () => {
    setRouter({ attemptedProvider: "azure-ad" });
    const known = render(<EnterpriseSsoRequiredPage />);
    expect(known.container.textContent).toContain("Azure AD");

    known.unmount();
    setRouter({ attemptedProvider: "okta-something" });
    const unknown = render(<EnterpriseSsoRequiredPage />);
    expect(unknown.container.textContent).toContain("okta something");
    expect(unknown.container.textContent).not.toContain("okta-something");
  });

  // H2
  it("H2 whitelists callbackUrl: only a single-slash internal path survives", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["https://evil.com", "/"],
      ["//evil.com", "/"],
      ["/project/x", "/project/x"],
      [undefined, "/"],
    ];

    for (const [callbackUrl, expected] of cases) {
      setRouter(callbackUrl === undefined ? {} : { callbackUrl });
      mockSignIn.mockResolvedValue(undefined);
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse(200, { providerId: "acme.test.okta" }),
      );

      const view = render(<EnterpriseSsoRequiredPage />);
      submit("user@acme.test");
      await waitFor(() =>
        expect(mockSignIn).toHaveBeenCalledWith("acme.test.okta", {
          callbackUrl: expected,
        }),
      );
      view.unmount();
      mockSignIn.mockClear();
    }
  });

  // H5
  it("H5 posts the lowercased domain as JSON to the check-sso endpoint", async () => {
    mockSignIn.mockResolvedValue(undefined);
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, { providerId: "crm.test.okta" }),
    );

    render(<EnterpriseSsoRequiredPage />);
    submit("Someone@CRM.Test");

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("/api/auth/check-sso");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ domain: "crm.test" });
  });

  // H4
  it("H4 redirects an authenticated session and renders nothing", async () => {
    setRouter({ callbackUrl: "/project/x" });
    setSession("authenticated");

    const { container } = render(<EnterpriseSsoRequiredPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/project/x"));
    expect(container.firstChild).toBeNull();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  // H4 (whitelist control): an external callbackUrl redirects to "/"
  it("H4 redirects an authenticated session with an external callbackUrl to /", async () => {
    setRouter({ callbackUrl: "https://evil.com" });
    setSession("authenticated");

    render(<EnterpriseSsoRequiredPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  // H6
  it("H6 shows the exact wording when check-sso answers 404", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(404, { message: "No SSO provider configured" }),
    );

    render(<EnterpriseSsoRequiredPage />);
    submit("user@acme.test");
    await assertErrorText(
      "We couldn't find a custom Enterprise SSO configuration for this domain. Double-check your company email or contact your administrator.",
    );
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  // H7
  it("H7 uses the response message for other failures and falls back when there is none", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(500, { message: "backend exploded" }),
    );
    const first = render(<EnterpriseSsoRequiredPage />);
    submit("user@acme.test");
    await assertErrorText("backend exploded");
    first.unmount();

    // Non-JSON body: json() rejects, so the fallback must be used.
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(500, new Error("not json")),
    );
    render(<EnterpriseSsoRequiredPage />);
    submit("user@acme.test");
    await assertErrorText(
      "Unable to start the Enterprise SSO sign-in flow. Please try again.",
    );
  });

  // H8
  it("H8 reports a thrown fetch to Sentry and shows the catch wording", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    render(<EnterpriseSsoRequiredPage />);
    submit("user@acme.test");

    await assertErrorText(
      "Something went wrong while checking your Enterprise SSO configuration. Please try again.",
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});
