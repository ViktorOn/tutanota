// @flow

import {create, TypeRef} from "../../common/EntityFunctions"

export const InvoiceItemTypeRef: TypeRef<InvoiceItem> = new TypeRef("sys", "InvoiceItem")
export const _TypeModel: TypeModel = {
	"name": "InvoiceItem",
	"since": 52,
	"type": "AGGREGATED_TYPE",
	"id": 1641,
	"rootId": "A3N5cwAGaQ",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_id": {"name": "_id", "id": 1642, "since": 52, "type": "CustomId", "cardinality": "One", "final": true, "encrypted": false},
		"amount": {"name": "amount", "id": 1643, "since": 52, "type": "Number", "cardinality": "One", "final": false, "encrypted": true},
		"endDate": {
			"name": "endDate",
			"id": 1648,
			"since": 52,
			"type": "Date",
			"cardinality": "ZeroOrOne",
			"final": false,
			"encrypted": true
		},
		"singlePrice": {
			"name": "singlePrice",
			"id": 1645,
			"since": 52,
			"type": "Number",
			"cardinality": "ZeroOrOne",
			"final": false,
			"encrypted": true
		},
		"singleType": {
			"name": "singleType",
			"id": 1649,
			"since": 52,
			"type": "Boolean",
			"cardinality": "One",
			"final": false,
			"encrypted": true
		},
		"startDate": {
			"name": "startDate",
			"id": 1647,
			"since": 52,
			"type": "Date",
			"cardinality": "ZeroOrOne",
			"final": false,
			"encrypted": true
		},
		"totalPrice": {
			"name": "totalPrice",
			"id": 1646,
			"since": 52,
			"type": "Number",
			"cardinality": "One",
			"final": false,
			"encrypted": true
		},
		"type": {"name": "type", "id": 1644, "since": 52, "type": "Number", "cardinality": "One", "final": false, "encrypted": true}
	},
	"associations": {},
	"app": "sys",
	"version": "52"
}

export function createInvoiceItem(values?: $Shape<$Exact<InvoiceItem>>): InvoiceItem {
	return Object.assign(create(_TypeModel, InvoiceItemTypeRef), values)
}
