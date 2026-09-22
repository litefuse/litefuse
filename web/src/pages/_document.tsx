import Document, {
  Head,
  Html,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from "next/document";
import { resolveRequestI18n } from "@/src/features/i18n/getI18nAppProps";

type Props = DocumentInitialProps & { lang: string };

/** Only exists to set <html lang> from the resolved locale (not the URL). */
export default function MyDocument({ lang }: Props) {
  return (
    <Html lang={lang}>
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

MyDocument.getInitialProps = async (ctx: DocumentContext): Promise<Props> => {
  const initialProps = await Document.getInitialProps(ctx);
  return { ...initialProps, lang: resolveRequestI18n(ctx.req).locale };
};
