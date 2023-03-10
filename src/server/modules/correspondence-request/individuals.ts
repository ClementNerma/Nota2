import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { createApiClient } from '../../../common/trpc-client'
import { generateRandomUUID } from '../../../common/crypto'
import { fallible, pick } from '../../../common/utils'
import { createRouter } from '../../router'
import { zSymEncrypted } from '../../../common/domain-utils'
import { authProcedure, publicProcedure } from '../auth'
import { CONFIG } from '../../config'

export default createRouter({
	// From initiator (client) to initiator (server)
	generateCode: authProcedure
		.input(
			z.object({
				correspondenceInitPrivateKeyMK: zSymEncrypted,
				correspondenceInitPublicKeyJWK: z.string(),
			}),
		)
		.mutation<{ correspondenceCode: string }>(async ({ ctx, input }) => {
			// TODO: use a passphrase here

			const correspondenceCode = generateRandomUUID()

			await ctx.db.individualLv1BCorrespondenceRequest.create({
				data: {
					forUserId: ctx.viewer.id,

					correspondenceInitID: generateRandomUUID(),
					correspondenceInitPrivateKeyMK: input.correspondenceInitPrivateKeyMK.content,
					correspondenceInitPrivateKeyMKIV: input.correspondenceInitPrivateKeyMK.iv,
					correspondenceInitPublicKeyJWK: input.correspondenceInitPublicKeyJWK,

					correspondenceCode,
				},
			})

			return { correspondenceCode }
		}),

	// From target (client) to initiator (server)
	getPublicKey: publicProcedure
		.input(
			z.object({
				correspondenceCode: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const request = await ctx.db.individualLv1BCorrespondenceRequest.findUnique({
				where: {
					correspondenceCode: input.correspondenceCode,
				},
			})

			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'Provided correspondence init. ID was not found' })
			}

			return pick(request, ['correspondenceInitPublicKeyJWK', 'correspondenceInitID'])
		}),

	// From target (client) to target (server)
	createAnswered: authProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
				correspondenceKeyMK: zSymEncrypted,

				serverUrl: z.string(),

				correspondenceKeyCIPK: z.string(),
				targetDisplayNameCK: zSymEncrypted,
			}),
		)
		.mutation<void>(async ({ ctx, input }) => {
			const { id } = await ctx.db.individualLv2ACorrespondenceRequest.create({
				data: {
					forUserId: ctx.viewer.id,

					correspondenceInitID: input.correspondenceInitID,
					correspondenceKeyMK: input.correspondenceKeyMK.content,
					correspondenceKeyMKIV: input.correspondenceKeyMK.iv,

					serverUrl: input.serverUrl,
				},
			})

			const distantApi = createApiClient(input.serverUrl)

			const result = await fallible(() =>
				distantApi.correspondenceRequest.individuals.fillInfos.mutate({
					correspondenceInitID: input.correspondenceInitID,
					correspondenceKeyCIPK: input.correspondenceKeyCIPK,
					targetDisplayNameCK: input.targetDisplayNameCK,
					serverUrl: `${CONFIG.CURRENT_SERVER_URL}:${CONFIG.CURRENT_SERVER_PORT}`,
				}),
			)

			if (result instanceof Error) {
				await ctx.db.individualLv2ACorrespondenceRequest.delete({
					where: { id },
				})

				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to contact distant API: ${result.message}`,
				})
			}
		}),

	// From target (server) to initiator (server)
	fillInfos: publicProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
				correspondenceKeyCIPK: z.string(),
				serverUrl: z.string(),
				targetDisplayNameCK: zSymEncrypted,
			}),
		)
		.mutation<void>(async ({ ctx, input }) => {
			const request = await ctx.db.individualLv1BCorrespondenceRequest.findUnique({
				where: {
					correspondenceInitID: input.correspondenceInitID,
				},
			})

			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'Provided correspondence init. ID was not found' })
			}

			await ctx.db.individualLv2BCorrespondenceRequest.create({
				data: {
					forUserId: request.forUserId,
					fromId: request.id,

					correspondenceKeyCIPK: input.correspondenceKeyCIPK,

					serverUrl: input.serverUrl,
					targetDisplayNameCK: input.targetDisplayNameCK.content,
					targetDisplayNameCKIV: input.targetDisplayNameCK.iv,
				},
			})
		}),

	// From initiator (server) to initiator (client)
	pendingFilledRequests: authProcedure.query(({ ctx }) =>
		ctx.db.individualLv2BCorrespondenceRequest.findMany({
			select: {
				targetDisplayNameCK: true,
				targetDisplayNameCKIV: true,
				// Here we return the correspondence key encrypted with a public key...
				correspondenceKeyCIPK: true,
				from: {
					select: {
						// ...that couples with this private key!
						correspondenceInitPrivateKeyMK: true,
						correspondenceInitPrivateKeyMKIV: true,

						correspondenceInitID: true,
					},
				},
			},
			where: {
				forUserId: ctx.viewer.id,
				into: null,
			},
		}),
	),

	// From initiator (client) to initiator (server)
	answerFilledRequest: authProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
				correspondenceKeyMK: zSymEncrypted,
				initiatorDisplayNameCK: zSymEncrypted,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const base = await ctx.db.individualLv1BCorrespondenceRequest.findUnique({
				where: { correspondenceInitID: input.correspondenceInitID },
				include: { into: true },
			})

			if (!base) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'The provided correspondence init. ID was not found' })
			}

			if (base.forUserId !== ctx.viewer.id) {
				throw new TRPCError({ code: 'FORBIDDEN', message: 'This correspondence init. request belongs to another user' })
			}

			if (!base.into) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: 'This correspondence request is not advanced enough to perform this operation',
				})
			}

			const { into } = base

			const { id } = await ctx.db.individualLv3BCorrespondenceRequest.create({
				data: {
					fromId: into.id,
					forUserId: ctx.viewer.id,

					correspondenceKeyMK: input.correspondenceKeyMK.content,
					correspondenceKeyMKIV: input.correspondenceKeyMK.iv,
				},
			})

			const distantApi = createApiClient(into.serverUrl)

			const result = await fallible(() =>
				distantApi.correspondenceRequest.individuals.receiveFilledRequestAnswer.mutate({
					correspondenceInitID: input.correspondenceInitID,
					initiatorDisplayNameCK: input.initiatorDisplayNameCK,
				}),
			)

			if (result instanceof Error) {
				await ctx.db.individualLv3BCorrespondenceRequest.delete({
					where: { id },
				})

				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to contact distant API: ${result.message}`,
				})
			}
		}),

	// From initiator (server) to target (server)
	receiveFilledRequestAnswer: publicProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
				initiatorDisplayNameCK: zSymEncrypted,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const request = await ctx.db.individualLv2ACorrespondenceRequest.findUnique({
				where: {
					correspondenceInitID: input.correspondenceInitID,
				},
			})

			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'The provided request was not found' })
			}

			await ctx.db.individualLv3ACorrespondenceRequest.create({
				data: {
					forUserId: request.forUserId,
					fromId: request.id,
					initiatorDisplayNameCK: input.initiatorDisplayNameCK.content,
					initiatorDisplayNameCKIV: input.initiatorDisplayNameCK.iv,
				},
			})
		}),

	// From target (server) to target (client)
	pendingFullyFilledRequests: authProcedure.query(({ ctx }) =>
		ctx.db.individualLv3ACorrespondenceRequest.findMany({
			select: {
				initiatorDisplayNameCK: true,
				initiatorDisplayNameCKIV: true,
				from: {
					select: {
						correspondenceInitID: true,
						correspondenceKeyMK: true,
						correspondenceKeyMKIV: true,
						serverUrl: true,
					},
				},
			},
			where: {
				forUserId: ctx.viewer.id,
			},
		}),
	),

	// From target (client) to target (server)
	markAcceptedRequest: authProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const base = await ctx.db.individualLv2ACorrespondenceRequest.findUnique({
				where: {
					correspondenceInitID: input.correspondenceInitID,
				},
				include: { into: true },
			})

			if (base === null) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'The provided correspondence init. ID was not found' })
			}

			if (base.forUserId !== ctx.viewer.id) {
				throw new TRPCError({ code: 'FORBIDDEN', message: 'The provided correspondence belongs to another user' })
			}

			if (!base.into) {
				throw new TRPCError({
					code: 'BAD_REQUEST',
					message: 'This correspondence request is not advanced enough to perform this operation',
				})
			}

			const incomingAccessToken = generateRandomUUID()
			const outgoingAccessToken = generateRandomUUID()

			const into = base.into

			const distantApi = createApiClient(base.serverUrl)

			await distantApi.correspondenceRequest.individuals.fullyAcceptRequest.mutate({
				correspondenceInitID: base.correspondenceInitID,
				incomingAccessToken: outgoingAccessToken,
				outgoingAccessToken: incomingAccessToken,
			})

			await ctx.db.$transaction([
				// Will delete the 3A by cascade
				ctx.db.individualLv2ACorrespondenceRequest.delete({
					where: {
						id: base.id,
					},
				}),

				ctx.db.correspondent.create({
					data: {
						forUserId: ctx.viewer.id,

						incomingAccessToken,
						outgoingAccessToken,

						isInitiator: true,
						isService: false,

						correspondenceKeyMK: base.correspondenceKeyMK,
						correspondenceKeyMKIV: base.correspondenceKeyMKIV,

						displayNameCK: into.initiatorDisplayNameCK,
						displayNameCKIV: into.initiatorDisplayNameCKIV,

						serverUrl: base.serverUrl,
					},
				}),
			])
		}),

	// From target (server) to initiator (server)
	fullyAcceptRequest: publicProcedure
		.input(
			z.object({
				correspondenceInitID: z.string(),
				incomingAccessToken: z.string(),
				outgoingAccessToken: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const base = await ctx.db.individualLv1BCorrespondenceRequest.findUnique({
				where: {
					correspondenceInitID: input.correspondenceInitID,
				},
				include: { into: { include: { into: true } } },
			})

			if (base === null) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'The provided correspondence init. ID was not found' })
			}

			if (!base.into) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: 'This correspondence request is not advanced enough to perform this operation',
				})
			}

			if (!base.into.into) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: 'This correspondence request is not advanced enough to perform this operation',
				})
			}

			await ctx.db.$transaction([
				// Will delete the 2B and 3B by cascade
				ctx.db.individualLv1BCorrespondenceRequest.delete({
					where: {
						id: base.id,
					},
				}),
				ctx.db.correspondent.create({
					data: {
						forUserId: base.forUserId,

						isInitiator: false,
						isService: false,

						incomingAccessToken: input.incomingAccessToken,
						outgoingAccessToken: input.outgoingAccessToken,

						correspondenceKeyMK: base.into.into.correspondenceKeyMK,
						correspondenceKeyMKIV: base.into.into.correspondenceKeyMKIV,

						displayNameCK: base.into.targetDisplayNameCK,
						displayNameCKIV: base.into.targetDisplayNameCKIV,

						serverUrl: base.into.serverUrl,
					},
				}),
			])
		}),
})
