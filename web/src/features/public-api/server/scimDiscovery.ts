import { type NextApiResponse } from "next";

/**
 * The discovery declarations a SCIM client reads to learn what this service
 * provider supports: the resource types (=`/ResourceTypes`) and the attribute
 * schema of the User resource (=`/Schemas`).
 *
 * They live here rather than inside the two collection handlers because each
 * collection has a sibling endpoint for a single entry - `/ResourceTypes/{id}`
 * and `/Schemas/{id}` - and both have to answer with exactly the same
 * declaration. The `meta.location` values are derived from the route + id
 * constants below, so a declaration can never point at a path this service does
 * not serve.
 */

/** Resource type id of the only resource type this service provides. */
export const USER_RESOURCE_TYPE_ID = "User";

/** `id` of the User schema, as registered with IANA. */
export const USER_SCHEMA_URN = "urn:ietf:params:scim:schemas:core:2.0:User";

export const RESOURCE_TYPES_PATH = "/api/public/scim/ResourceTypes";
export const SCHEMAS_PATH = "/api/public/scim/Schemas";

/** `meta.location` of the User resource type. */
export const RESOURCE_TYPE_PATH = `${RESOURCE_TYPES_PATH}/${USER_RESOURCE_TYPE_ID}`;

/** `meta.location` of the User schema. */
export const SCHEMA_PATH = `${SCHEMAS_PATH}/${USER_SCHEMA_URN}`;

/**
 * `GET /ResourceTypes` entry and `GET /ResourceTypes/User` body. A fresh object
 * per call, so a handler cannot leak mutations into the next request.
 */
export function userResourceType() {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/api/public/scim/Users",
    description: "User Account",
    schema: "urn:ietf:params:scim:schemas:core:2.0:User",
    schemaExtensions: [],
    meta: {
      resourceType: "ResourceType",
      location: RESOURCE_TYPE_PATH,
    },
  };
}

/**
 * `GET /Schemas` entry and `GET /Schemas/{urn}` body.
 */
export function userSchemaDeclaration() {
  return {
    id: "urn:ietf:params:scim:schemas:core:2.0:User",
    name: "User",
    description: "User Account",
    attributes: [
      {
        name: "id",
        type: "string",
        multiValued: false,
        description: "Unique identifier for the User",
        required: true,
        caseExact: true,
        mutability: "readOnly",
        returned: "always",
        uniqueness: "server",
      },
      {
        name: "externalId",
        type: "string",
        multiValued: false,
        description:
          "Identifier of the user in the provisioning client. Litefuse returns its own user id here, so clients can keep their link and address the user by id.",
        required: false,
        caseExact: true,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "userName",
        type: "string",
        multiValued: false,
        description:
          "Unique identifier for the User, and the source of the email address in Litefuse",
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "always",
        uniqueness: "server",
      },
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        description:
          "The name of the user, suitable for display to end-users. Maps to the same value as name.formatted.",
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "name",
        type: "complex",
        multiValued: false,
        description: "The components of the user's name",
        required: false,
        subAttributes: [
          {
            name: "formatted",
            type: "string",
            multiValued: false,
            description: "The user's full name",
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "givenName",
            type: "string",
            multiValued: false,
            description:
              "The first name of the user. Accepted on write; joined with familyName into the stored name.",
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "familyName",
            type: "string",
            multiValued: false,
            description:
              "The last name of the user. Accepted on write; joined with givenName into the stored name.",
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
        ],
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "emails",
        type: "complex",
        multiValued: true,
        description: "Email addresses for the user",
        required: false,
        subAttributes: [
          {
            name: "value",
            type: "string",
            multiValued: false,
            description: "Email address value",
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "primary",
            type: "boolean",
            multiValued: false,
            description: "Primary email indicator",
            required: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "type",
            type: "string",
            multiValued: false,
            description: "Email type (work, home, other)",
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
        ],
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "password",
        type: "string",
        multiValued: false,
        description: "The user's password",
        required: false,
        caseExact: false,
        mutability: "writeOnly",
        returned: "never",
        uniqueness: "none",
      },
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        description:
          "Whether the user is an active member of the organization. Setting it to false removes the organization membership (deprovisions the user), setting it to true re-provisions them.",
        required: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "roles",
        type: "string",
        multiValued: true,
        description:
          'Organization role of the user, as an array of strings (["ADMIN"]). Requests also accept the complex form ([{"value":"ADMIN"}]) and the path form with a single value.',
        required: false,
        caseExact: true,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "meta",
        type: "complex",
        multiValued: false,
        description: "Resource metadata",
        required: false,
        subAttributes: [
          {
            name: "resourceType",
            type: "string",
            multiValued: false,
            description: "The resource type",
            required: false,
            caseExact: true,
            mutability: "readOnly",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "created",
            type: "dateTime",
            multiValued: false,
            description: "The resource creation time",
            required: false,
            mutability: "readOnly",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "lastModified",
            type: "dateTime",
            multiValued: false,
            description: "The resource last modification time",
            required: false,
            mutability: "readOnly",
            returned: "default",
            uniqueness: "none",
          },
        ],
        mutability: "readOnly",
        returned: "default",
        uniqueness: "none",
      },
    ],
    meta: {
      resourceType: "Schema",
      location: SCHEMA_PATH,
    },
  };
}

/** RFC 7644 section 3.12 error body, for an unknown id on the two endpoints. */
export function writeNotFound(res: NextApiResponse, detail: string) {
  res.status(404).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail,
    status: 404,
  });
}
