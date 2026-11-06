import { Link } from 'react-router-dom';
import { CATEGORIES, type CategoryId } from '../../lib/integrations';

/** Category rail. Counts are connected items only; unknown (still loading) shows nothing. */
export function IntegrationRail({
  current,
  counts,
}: {
  current: CategoryId;
  counts?: Record<CategoryId, number>;
}) {
  return (
    <nav className="integration-rail" aria-label="Integration categories">
      {CATEGORIES.map((category) => (
        <Link
          key={category.id}
          to={'/integrations/' + category.id}
          className={
            'integration-rail-item' +
            (category.id === 'system' ? ' integration-rail-item--system' : '') +
            (category.id === current ? ' is-current' : '')
          }
          aria-current={category.id === current ? 'page' : undefined}
        >
          <span>{category.label}</span>
          {category.kind && counts && counts[category.id] > 0 && (
            <span
              className="integration-rail-count"
              aria-label={counts[category.id] + ' connected'}
            >
              {counts[category.id]}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
