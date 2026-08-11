import { Link } from "react-router-dom";
import { AdminIcon } from "../components/AdminIcon";

export function NotFoundPage() {
  return (
    <section className="not-found">
      <span className="not-found-code">404 / OFF RAIL</span>
      <h1>This control path<br />doesn't exist.</h1>
      <p>No admin route is configured at this address.</p>
      <Link className="button-link" to="/">Return to overview <AdminIcon name="arrow" size={17} /></Link>
    </section>
  );
}
