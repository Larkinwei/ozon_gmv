import { ResellTasksPanel } from "../components/ResellTasksPanel";

/** Presents the existing publish task history as a first-class operations page. */
export default function PublishTasksPage(): React.JSX.Element {
  return (
    <main className="admin-main selection-main operations-publish-main">
      <ResellTasksPanel />
    </main>
  );
}
