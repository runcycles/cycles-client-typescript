export const metadata = {
  title: "Cycles + Vercel AI SDK",
  description: "Budget-governed AI chat with Cycles and the Vercel AI SDK",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
