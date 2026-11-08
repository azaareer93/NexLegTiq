import type { RedactionContext } from '../ai/redaction';

interface FileReader {
  legalFile: {
    findFirstOrThrow(args: {
      where: { id: string };
      select: typeof FILE_PEOPLE;
    }): Promise<FilePeople>;
  };
}

const FILE_PEOPLE = {
  responsibleLawyer: { select: { fullName: true } },
  clients: {
    select: {
      client: {
        select: {
          clientType: true,
          displayName: true,
          fullName: true,
          companyName: true,
          contacts: { select: { fullName: true } },
        },
      },
    },
  },
  parties: {
    select: {
      party: {
        select: {
          isIndividual: true,
          fullName: true,
          companyName: true,
          legalRepresentative: true,
        },
      },
    },
  },
  teamMembers: { select: { user: { select: { fullName: true } } } },
} as const;

interface FilePeople {
  responsibleLawyer: { fullName: string };
  clients: {
    client: {
      clientType: string;
      displayName: string;
      fullName: string | null;
      companyName: string | null;
      contacts: { fullName: string }[];
    };
  }[];
  parties: {
    party: {
      isIndividual: boolean;
      fullName: string | null;
      companyName: string | null;
      legalRepresentative: string | null;
    };
  }[];
  teamMembers: { user: { fullName: string } }[];
}

const present = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value?.trim()))),
];

/**
 * Who the PII redactor must hide in a file's documents (D-057, D-131): its clients and their contact persons, parties and their legal representatives, and team as people, and
 * the companies and bodies among them as organisations (matched whole only).
 */
export async function fileRedactionContext(
  db: FileReader,
  fileId: string,
): Promise<RedactionContext> {
  const file = await db.legalFile.findFirstOrThrow({ where: { id: fileId }, select: FILE_PEOPLE });
  const clients = file.clients.map(({ client }) => client);
  const people = clients.filter((client) => client.clientType === 'INDIVIDUAL');
  const bodies = clients.filter((client) => client.clientType !== 'INDIVIDUAL');
  const parties = file.parties.map(({ party }) => party);
  return {
    names: present([
      file.responsibleLawyer.fullName,
      ...file.teamMembers.map(({ user }) => user.fullName),
      ...people.flatMap((client) => [client.displayName, client.fullName]),
      ...parties.filter((party) => party.isIndividual).map((party) => party.fullName),
      ...parties.map((party) => party.legalRepresentative),
      ...clients.flatMap((client) => client.contacts.map((contact) => contact.fullName)),
    ]),
    organisations: present([
      ...bodies.flatMap((client) => [client.displayName, client.companyName]),
      ...parties.filter((party) => !party.isIndividual).map((party) => party.companyName),
    ]),
  };
}
