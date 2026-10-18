/**
 * Descriptions for operations whose OpenAPI entry carries only a summary.
 * The listing is what the model reads, and "List objects" says nothing about
 * what comes back or which argument matters. Only an operation with no
 * description of its own takes an entry here, and its curated line replaces
 * the bare summary. A route that gains a real description upstream drops out
 * of this table by itself.
 */
const OPERATION_DESCRIPTIONS: Record<string, string> = {
  list_objects:
    "List objects in a space. `fields` narrows each row to the named property keys; page with `offset` and `limit`.",
  list_types:
    "List the types in a space. Type keys are per space, so read this before creating an object or running a query.",
  get_type: "Get one type by its key. `ids=full` returns export-shaped ids instead of short labels.",
  list_properties:
    "List the properties in a space, with their keys. Object bodies and search filters address properties by these keys.",
  create_property:
    'Create a property. The body is a `kind: "property"` document carrying `key` and `name`; read `API-get-schema {"kind":"property"}` for its shape.',
  delete_property: "Delete a property by its key.",
  list_property_options: "List a select property's options. `prefix` filters names case-insensitively.",
  list_members: "List the members of a space.",
  list_schemas: "List the schema kinds that `API-get-schema` can describe.",
  get_schema:
    "Get the JSON schema and example for a kind. Read it before building an object, property or type body; kinds come from `API-list-schemas`.",
  get_collection_views:
    "List a collection's stored views. A view id feeds `API-get-collection-objects` to read its objects in the view's order.",
  get_query_views:
    "List a query's stored views. A view id feeds `API-get-query-objects`, which resolves the view's dynamic placeholders.",
  delete_type: "Delete a type by its key. Standard types cannot be removed.",
};

export function getDescriptionOverride(operationId: string | undefined): string | undefined {
  return operationId ? OPERATION_DESCRIPTIONS[operationId] : undefined;
}
