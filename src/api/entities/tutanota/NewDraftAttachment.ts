import {create} from "../../common/utils/EntityUtils.js"
import {TypeRef, downcast} from "@tutao/tutanota-utils"
import type {TypeModel} from "../../common/EntityTypes.js"

import type {BlobReferenceTokenWrapper} from "../sys/BlobReferenceTokenWrapper.js"

export const NewDraftAttachmentTypeRef: TypeRef<NewDraftAttachment> = new TypeRef("tutanota", "NewDraftAttachment")
export const _TypeModel: TypeModel = {
	"name": "NewDraftAttachment",
	"since": 11,
	"type": "AGGREGATED_TYPE",
	"id": 486,
	"rootId": "CHR1dGFub3RhAAHm",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_id": {
			"id": 487,
			"type": "CustomId",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		},
		"encCid": {
			"id": 925,
			"type": "Bytes",
			"cardinality": "ZeroOrOne",
			"final": true,
			"encrypted": false
		},
		"encFileName": {
			"id": 488,
			"type": "Bytes",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		},
		"encMimeType": {
			"id": 489,
			"type": "Bytes",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		}
	},
	"associations": {
		"fileData": {
			"id": 490,
			"type": "ELEMENT_ASSOCIATION",
			"cardinality": "ZeroOrOne",
			"final": true,
			"refType": "FileData",
			"dependency": null
		},
		"referenceTokens": {
			"id": 1226,
			"type": "AGGREGATION",
			"cardinality": "Any",
			"final": true,
			"refType": "BlobReferenceTokenWrapper",
			"dependency": "sys"
		}
	},
	"app": "tutanota",
	"version": "52"
}

export function createNewDraftAttachment(values?: Partial<NewDraftAttachment>): NewDraftAttachment {
	return Object.assign(create(_TypeModel, NewDraftAttachmentTypeRef), downcast<NewDraftAttachment>(values))
}

export type NewDraftAttachment = {
	_type: TypeRef<NewDraftAttachment>;

	_id: Id;
	encCid: null | Uint8Array;
	encFileName: Uint8Array;
	encMimeType: Uint8Array;

	fileData:  null | Id;
	referenceTokens: BlobReferenceTokenWrapper[];
}