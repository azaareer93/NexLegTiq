import { APP_NAME } from './app-name';

/** Placeholder route until the app shell lands. Only the product name is shown (not translatable). */
export function HomePage(): React.JSX.Element {
  return (
    <main data-testid="home-page">
      <h1>{APP_NAME}</h1>
    </main>
  );
}
