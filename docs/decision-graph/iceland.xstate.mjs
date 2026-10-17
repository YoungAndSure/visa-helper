// Generated from the server's executable XState model. Paste into open-source Stately Sketch.
import { setup, assign } from 'xstate';
const predicates = {"answered": (answers, { field }) => answers[field] !== undefined,
"equals": (answers, { field, value }) => answers[field] === value,
"oneOf": (answers, { field, values }) => values.includes(answers[field]),
"before": (answers, { left, right }) => answers[left] < answers[right],
"allEqual": (answers, { values }) => Object.entries(values).every(([key, value]) => answers[key] === value),
"inconsistentSpouse": (answers) => answers.sponsor === "spouse" && answers.maritalStatus !== "married",
"guardianAbroadReview": (answers) => ["alone", "one_parent", "other_guardian"].includes(answers.minorTravel) && answers.guardianAbroad === "yes",
"otherSponsorReview": (answers) => answers.occupation === "unemployed" && answers.sponsor === "other"};
function runtimeLogic(observeGuard = () => {}) {
  return {
    guards: Object.fromEntries(Object.entries(predicates).map(([name, predicate]) => [name, ({ context }, params) => {
      const result = predicate(context.answers, params);
      observeGuard({ nodeId: params.nodeId, guard: name, params, result });
      return result;
    }])),
    actions: {
      addTasks: assign(({ context }, { ids }) => ({ taskIds: [...new Set([...context.taskIds, ...ids])] })),
      addNotes: assign(({ context }, { ids }) => ({ noteIds: [...new Set([...context.noteIds, ...ids])] })),
    },
  };
}
const definition = {
  "id": "iceland-tourism-checklist",
  "initial": "q_nationality",
  "states": {
    "q_nationality": {
      "meta": {
        "kind": "question",
        "title": "申请人持有哪国护照？",
        "questionId": "nationality",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "nationality",
            "nodeId": "q_nationality"
          }
        },
        "target": "q_residence"
      }
    },
    "q_residence": {
      "meta": {
        "kind": "question",
        "title": "申请人目前居住在哪里？",
        "questionId": "residence",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "residence",
            "nodeId": "q_residence"
          }
        },
        "target": "q_applicationCity"
      }
    },
    "q_applicationCity": {
      "meta": {
        "kind": "question",
        "title": "计划在哪个中国城市递交申请？",
        "questionId": "applicationCity",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "applicationCity",
            "nodeId": "q_applicationCity"
          }
        },
        "target": "q_destination"
      }
    },
    "q_destination": {
      "meta": {
        "kind": "question",
        "title": "此行是否前往冰岛？",
        "questionId": "destination",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "destination",
            "nodeId": "q_destination"
          }
        },
        "target": "q_purpose"
      }
    },
    "q_purpose": {
      "meta": {
        "kind": "question",
        "title": "此行的目的是什么？",
        "questionId": "purpose",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "purpose",
            "nodeId": "q_purpose"
          }
        },
        "target": "q_arrivalDate"
      }
    },
    "q_arrivalDate": {
      "meta": {
        "kind": "question",
        "title": "计划何时进入申根区？",
        "questionId": "arrivalDate",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "arrivalDate",
            "nodeId": "q_arrivalDate"
          }
        },
        "target": "q_departureDate"
      }
    },
    "q_departureDate": {
      "meta": {
        "kind": "question",
        "title": "计划何时离开申根区？",
        "questionId": "departureDate",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "departureDate",
            "nodeId": "q_departureDate"
          }
        },
        "target": "q_ageGroup"
      }
    },
    "q_ageGroup": {
      "meta": {
        "kind": "question",
        "title": "出行时申请人是否已满 18 岁？",
        "questionId": "ageGroup",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "ageGroup",
            "nodeId": "q_ageGroup"
          }
        },
        "target": "q_otherSchengenCountries"
      }
    },
    "q_otherSchengenCountries": {
      "meta": {
        "kind": "question",
        "title": "这次是否还会去其他申根国家？",
        "questionId": "otherSchengenCountries",
        "groupId": "basic"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "otherSchengenCountries",
            "nodeId": "q_otherSchengenCountries"
          }
        },
        "target": "check_dates"
      }
    },
    "check_dates": {
      "meta": {
        "kind": "decision",
        "title": "进入日期早于离开日期？"
      },
      "always": [
        {
          "guard": {
            "type": "before",
            "params": {
              "left": "arrivalDate",
              "right": "departureDate",
              "nodeId": "check_dates"
            }
          },
          "target": "check_scope"
        },
        {
          "target": "stop_dates"
        }
      ]
    },
    "stop_dates": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "离开申根区的日期必须晚于进入日期。",
        "status": "needs_correction",
        "reason": "离开申根区的日期必须晚于进入日期。",
        "groupId": "basic"
      }
    },
    "check_scope": {
      "meta": {
        "kind": "decision",
        "title": "中国护照、居住中国、冰岛个人旅游？"
      },
      "always": [
        {
          "guard": {
            "type": "allEqual",
            "params": {
              "values": {
                "nationality": "CN",
                "residence": "CN",
                "destination": "IS",
                "purpose": "tourism"
              },
              "nodeId": "check_scope"
            }
          },
          "target": "materials_common"
        },
        {
          "target": "stop_scope"
        }
      ]
    },
    "stop_scope": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "当前版本仅覆盖中国护照、居住中国、赴冰岛个人旅游的申请人。",
        "status": "unsupported",
        "reason": "当前模拟仅覆盖中国护照、居住中国、赴冰岛个人旅游的申请人。",
        "groupId": null
      }
    },
    "materials_common": {
      "meta": {
        "kind": "tasks",
        "title": "共通材料（原表第 1–10 项）",
        "taskIds": [
          "schengen_form",
          "passport",
          "photo",
          "travel_insurance",
          "round_trip_reservation",
          "daily_itinerary",
          "accommodation",
          "chinese_id_copy",
          "hukou_copy",
          "bank_statements"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "schengen_form",
              "passport",
              "photo",
              "travel_insurance",
              "round_trip_reservation",
              "daily_itinerary",
              "accommodation",
              "chinese_id_copy",
              "hukou_copy",
              "bank_statements"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "route_countries"
      }
    },
    "route_countries": {
      "meta": {
        "kind": "decision",
        "title": "是否还有其他申根国家？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "otherSchengenCountries",
              "value": "yes",
              "nodeId": "route_countries"
            }
          },
          "target": "q_icelandMainDestination"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "otherSchengenCountries",
              "value": "no",
              "nodeId": "route_countries"
            }
          },
          "target": "route_age"
        }
      ]
    },
    "q_icelandMainDestination": {
      "meta": {
        "kind": "question",
        "title": "冰岛是否为此次申根行程停留时间最长的国家？",
        "questionId": "icelandMainDestination",
        "groupId": "multi_country"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "icelandMainDestination",
            "nodeId": "q_icelandMainDestination"
          }
        },
        "target": "check_main_destination"
      }
    },
    "check_main_destination": {
      "meta": {
        "kind": "decision",
        "title": "冰岛是否为主要目的地？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "icelandMainDestination",
              "value": "no",
              "nodeId": "check_main_destination"
            }
          },
          "target": "stop_destination"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "icelandMainDestination",
              "value": "unsure",
              "nodeId": "check_main_destination"
            }
          },
          "target": "stop_unsure"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "icelandMainDestination",
              "value": "yes",
              "nodeId": "check_main_destination"
            }
          },
          "target": "materials_multi"
        }
      ]
    },
    "stop_destination": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "冰岛不是停留时间最长的目的地，当前流程不能套用冰岛申请清单。",
        "status": "unsupported",
        "reason": "冰岛不是停留时间最长的目的地，本模拟不能套用冰岛申请清单。",
        "groupId": null
      }
    },
    "stop_unsure": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "冰岛是否为主要目的地尚不能确认；当前流程暂不生成确定清单。",
        "status": "needs_review",
        "reason": "冰岛是否为主要目的地尚不能确认；本模拟暂不生成确定清单。",
        "groupId": null
      }
    },
    "materials_multi": {
      "meta": {
        "kind": "tasks",
        "title": "多国行程材料",
        "taskIds": [
          "intra_schengen_transport"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "intra_schengen_transport"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "route_age"
      }
    },
    "route_age": {
      "meta": {
        "kind": "decision",
        "title": "成年还是未成年？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "ageGroup",
              "value": "adult",
              "nodeId": "route_age"
            }
          },
          "target": "q_occupation"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "ageGroup",
              "value": "minor",
              "nodeId": "route_age"
            }
          },
          "target": "q_inSchool"
        }
      ]
    },
    "q_occupation": {
      "meta": {
        "kind": "question",
        "title": "目前属于哪种情况？",
        "questionId": "occupation",
        "groupId": "adult"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "occupation",
            "nodeId": "q_occupation"
          }
        },
        "target": "route_occupation"
      }
    },
    "route_occupation": {
      "meta": {
        "kind": "decision",
        "title": "成年申请人的职业分支"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "occupation",
              "value": "employed",
              "nodeId": "route_occupation"
            }
          },
          "target": "materials_employed"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "occupation",
              "value": "retired",
              "nodeId": "route_occupation"
            }
          },
          "target": "materials_retired"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "occupation",
              "value": "unemployed",
              "nodeId": "route_occupation"
            }
          },
          "target": "q_maritalStatus"
        }
      ]
    },
    "materials_employed": {
      "meta": {
        "kind": "tasks",
        "title": "在职材料",
        "taskIds": [
          "employer_license",
          "employment_letter"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "employer_license",
              "employment_letter"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "check_sponsor_note"
      }
    },
    "materials_retired": {
      "meta": {
        "kind": "tasks",
        "title": "退休收入材料",
        "taskIds": [
          "pension_income"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "pension_income"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "check_sponsor_note"
      }
    },
    "q_maritalStatus": {
      "meta": {
        "kind": "question",
        "title": "目前婚姻状态是？",
        "questionId": "maritalStatus",
        "groupId": "unemployed"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "maritalStatus",
            "nodeId": "q_maritalStatus"
          }
        },
        "target": "q_sponsor"
      }
    },
    "q_sponsor": {
      "meta": {
        "kind": "question",
        "title": "此次旅行由谁提供资金支持？",
        "questionId": "sponsor",
        "groupId": "unemployed"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "sponsor",
            "nodeId": "q_sponsor"
          }
        },
        "target": "check_sponsor_consistency"
      }
    },
    "check_sponsor_consistency": {
      "meta": {
        "kind": "decision",
        "title": "婚姻状态与配偶担保是否一致？"
      },
      "always": [
        {
          "guard": {
            "type": "inconsistentSpouse",
            "params": {
              "nodeId": "check_sponsor_consistency"
            }
          },
          "target": "stop_sponsor"
        },
        {
          "target": "route_marital_status"
        }
      ]
    },
    "stop_sponsor": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "婚姻状态与资金支持人不一致，请更正。",
        "status": "needs_correction",
        "reason": "婚姻状态与资金支持人不一致，请更正。",
        "groupId": "unemployed"
      }
    },
    "route_marital_status": {
      "meta": {
        "kind": "decision",
        "title": "无业申请人的婚姻分支"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "maritalStatus",
              "value": "married",
              "nodeId": "route_marital_status"
            }
          },
          "target": "materials_spouse"
        },
        {
          "guard": {
            "type": "oneOf",
            "params": {
              "field": "maritalStatus",
              "values": [
                "single",
                "divorced",
                "widowed"
              ],
              "nodeId": "route_marital_status"
            }
          },
          "target": "materials_regular_income"
        }
      ]
    },
    "materials_spouse": {
      "meta": {
        "kind": "tasks",
        "title": "已婚无业材料",
        "taskIds": [
          "spouse_employment_income",
          "marriage_certificate"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "spouse_employment_income",
              "marriage_certificate"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "route_sponsor"
      }
    },
    "materials_regular_income": {
      "meta": {
        "kind": "tasks",
        "title": "其他固定收入材料",
        "taskIds": [
          "other_regular_income"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "other_regular_income"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "route_sponsor"
      }
    },
    "route_sponsor": {
      "meta": {
        "kind": "decision",
        "title": "是否由非配偶担保？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "sponsor",
              "value": "other",
              "nodeId": "route_sponsor"
            }
          },
          "target": "materials_other_sponsor"
        },
        {
          "target": "check_sponsor_note"
        }
      ]
    },
    "materials_other_sponsor": {
      "meta": {
        "kind": "tasks",
        "title": "非配偶担保材料",
        "taskIds": [
          "sponsor_employment_income",
          "sponsor_bank_statements",
          "sponsorship_letter",
          "sponsor_passport_copy"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "sponsor_employment_income",
              "sponsor_bank_statements",
              "sponsorship_letter",
              "sponsor_passport_copy"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "check_sponsor_note"
      }
    },
    "q_inSchool": {
      "meta": {
        "kind": "question",
        "title": "申请人目前是否在读？",
        "questionId": "inSchool",
        "groupId": "minor"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "inSchool",
            "nodeId": "q_inSchool"
          }
        },
        "target": "q_minorTravel"
      }
    },
    "q_minorTravel": {
      "meta": {
        "kind": "question",
        "title": "未成年人将与谁同行？",
        "questionId": "minorTravel",
        "groupId": "minor"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "minorTravel",
            "nodeId": "q_minorTravel"
          }
        },
        "target": "route_guardian_question"
      }
    },
    "route_guardian_question": {
      "meta": {
        "kind": "decision",
        "title": "是否需要补充监护人所在地？"
      },
      "always": [
        {
          "guard": {
            "type": "oneOf",
            "params": {
              "field": "minorTravel",
              "values": [
                "alone",
                "one_parent",
                "other_guardian"
              ],
              "nodeId": "route_guardian_question"
            }
          },
          "target": "q_guardianAbroad"
        },
        {
          "target": "materials_minor"
        }
      ]
    },
    "q_guardianAbroad": {
      "meta": {
        "kind": "question",
        "title": "需要出具同意文件的家长或监护人是否有人不在中国？",
        "questionId": "guardianAbroad",
        "groupId": "minor_consent"
      },
      "always": {
        "guard": {
          "type": "answered",
          "params": {
            "field": "guardianAbroad",
            "nodeId": "q_guardianAbroad"
          }
        },
        "target": "materials_minor"
      }
    },
    "materials_minor": {
      "meta": {
        "kind": "tasks",
        "title": "未成年人亲属／监护关系材料",
        "taskIds": [
          "family_guardianship_certificate"
        ],
        "noteIds": [
          "minor_bank"
        ]
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "family_guardianship_certificate"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": [
              "minor_bank"
            ]
          }
        }
      ],
      "always": {
        "target": "route_school"
      }
    },
    "route_school": {
      "meta": {
        "kind": "decision",
        "title": "未成年人是否在读？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "inSchool",
              "value": "yes",
              "nodeId": "route_school"
            }
          },
          "target": "materials_school"
        },
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "inSchool",
              "value": "no",
              "nodeId": "route_school"
            }
          },
          "target": "note_no_school"
        }
      ]
    },
    "materials_school": {
      "meta": {
        "kind": "tasks",
        "title": "在读材料",
        "taskIds": [
          "student_card",
          "school_letter"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "student_card",
              "school_letter"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "route_other_guardian"
      }
    },
    "note_no_school": {
      "meta": {
        "kind": "note",
        "title": "未在读材料待核实",
        "noteIds": [
          "minor_not_school"
        ]
      },
      "entry": {
        "type": "addNotes",
        "params": {
          "ids": [
            "minor_not_school"
          ]
        }
      },
      "always": {
        "target": "route_other_guardian"
      }
    },
    "route_other_guardian": {
      "meta": {
        "kind": "decision",
        "title": "是否属于其他监护人同行？"
      },
      "always": [
        {
          "guard": {
            "type": "equals",
            "params": {
              "field": "minorTravel",
              "value": "other_guardian",
              "nodeId": "route_other_guardian"
            }
          },
          "target": "note_other_guardian"
        },
        {
          "target": "route_guardian_abroad"
        }
      ]
    },
    "note_other_guardian": {
      "meta": {
        "kind": "note",
        "title": "其他监护人要求待核实",
        "noteIds": [
          "other_guardian"
        ]
      },
      "entry": {
        "type": "addNotes",
        "params": {
          "ids": [
            "other_guardian"
          ]
        }
      },
      "always": {
        "target": "route_guardian_abroad"
      }
    },
    "route_guardian_abroad": {
      "meta": {
        "kind": "decision",
        "title": "需同意文件且有监护人在境外？"
      },
      "always": [
        {
          "guard": {
            "type": "guardianAbroadReview",
            "params": {
              "nodeId": "route_guardian_abroad"
            }
          },
          "target": "note_guardian_abroad"
        },
        {
          "target": "route_consent_material"
        }
      ]
    },
    "note_guardian_abroad": {
      "meta": {
        "kind": "note",
        "title": "境外同意文件形式待核实",
        "noteIds": [
          "guardian_abroad"
        ]
      },
      "entry": {
        "type": "addNotes",
        "params": {
          "ids": [
            "guardian_abroad"
          ]
        }
      },
      "always": {
        "target": "route_consent_material"
      }
    },
    "route_consent_material": {
      "meta": {
        "kind": "decision",
        "title": "独自或仅随一位家长出行？"
      },
      "always": [
        {
          "guard": {
            "type": "oneOf",
            "params": {
              "field": "minorTravel",
              "values": [
                "alone",
                "one_parent"
              ],
              "nodeId": "route_consent_material"
            }
          },
          "target": "materials_consent"
        },
        {
          "target": "check_sponsor_note"
        }
      ]
    },
    "materials_consent": {
      "meta": {
        "kind": "tasks",
        "title": "出行同意材料",
        "taskIds": [
          "travel_consent_certificate"
        ],
        "noteIds": []
      },
      "entry": [
        {
          "type": "addTasks",
          "params": {
            "ids": [
              "travel_consent_certificate"
            ]
          }
        },
        {
          "type": "addNotes",
          "params": {
            "ids": []
          }
        }
      ],
      "always": {
        "target": "check_sponsor_note"
      }
    },
    "check_sponsor_note": {
      "meta": {
        "kind": "decision",
        "title": "原审核表的无业与非配偶担保复核提示"
      },
      "always": [
        {
          "guard": {
            "type": "otherSponsorReview",
            "params": {
              "nodeId": "check_sponsor_note"
            }
          },
          "target": "note_sponsor"
        },
        {
          "target": "ready"
        }
      ]
    },
    "note_sponsor": {
      "meta": {
        "kind": "note",
        "title": "无业材料叠加待核实",
        "noteIds": [
          "sponsor_overlap"
        ]
      },
      "entry": {
        "type": "addNotes",
        "params": {
          "ids": [
            "sponsor_overlap"
          ]
        }
      },
      "always": {
        "target": "ready"
      }
    },
    "ready": {
      "type": "final",
      "meta": {
        "kind": "outcome",
        "title": "材料清单已就绪",
        "status": "tasks_ready"
      }
    }
  }
};
const exampleAnswers = {};
export const machine = setup(runtimeLogic()).createMachine({...definition, context: ({ input }) => ({ answers: input?.answers ?? exampleAnswers, taskIds: [], noteIds: [] })});
