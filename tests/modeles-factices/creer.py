"""
Fabrique deux micro-modèles ONNX (quelques centaines d'octets) pour les tests automatiques.
Les fichiers .onnx générés sont versionnés : inutile de relancer ce script (il sert de documentation).

  python3 tests/modeles-factices/creer.py      (nécessite : pip install onnx)

- ok.onnx  : accepte n'importe quelle taille d'image (entrée [1,3,H,W]) et renvoie un masque [1,1,H,W]
             (sigmoïde de la moyenne des canaux). Joue le rôle d'un modèle qui fonctionne.
- oom.onnx : même interface, mais tente d'allouer un tenseur de ~50 Go à l'INFÉRENCE. Reproduit l'échec
             « std::bad_alloc » observé avec BiRefNet lite en WebAssembly, sans télécharger 200 Mo.
"""
import os
import onnx
from onnx import TensorProto as T, helper as h

ICI = os.path.dirname(os.path.abspath(__file__))
ENTREE = h.make_tensor_value_info("input", T.FLOAT, [1, 3, "H", "W"])
SORTIE = h.make_tensor_value_info("output", T.FLOAT, [1, 1, "H", "W"])
cst = lambda nom, valeur, type_=T.FLOAT, dims=(): h.make_tensor(nom, type_, list(dims), valeur)


def enregistrer(nom, noeuds, initialisateurs):
    graphe = h.make_graph(noeuds, nom, [ENTREE], [SORTIE], initialisateurs)
    modele = h.make_model(graphe, opset_imports=[h.make_opsetid("", 13)])
    modele.ir_version = 8
    onnx.checker.check_model(modele)
    onnx.save(modele, os.path.join(ICI, f"{nom}.onnx"))
    print("écrit", nom + ".onnx")


moyenne = h.make_node("ReduceMean", ["input"], ["moyenne"], axes=[1], keepdims=1)

# ok.onnx : sortie = sigmoïde(3 × moyenne des canaux)
enregistrer(
    "ok",
    [moyenne, h.make_node("Mul", ["moyenne", "trois"], ["m3"]), h.make_node("Sigmoid", ["m3"], ["output"])],
    [cst("trois", [3.0])],
)

# oom.onnx : crée un tenseur [1,768,4H,4W] (~50 Go pour 512×512) dont la forme dépend de l'entrée,
# donc impossible à pré-calculer au chargement : l'échec survient bien pendant l'inférence.
enregistrer(
    "oom",
    [
        moyenne,
        h.make_node("Shape", ["input"], ["forme"]),
        h.make_node("Mul", ["forme", "facteurs"], ["grande_forme"]),
        h.make_node("ConstantOfShape", ["grande_forme"], ["enorme"], value=h.make_tensor("v", T.FLOAT, [1], [0.0])),
        h.make_node("ReduceMean", ["enorme"], ["m_enorme"], keepdims=0),
        h.make_node("Add", ["moyenne", "m_enorme"], ["somme"]),
        h.make_node("Sigmoid", ["somme"], ["output"]),
    ],
    [cst("facteurs", [1, 256, 8, 8], T.INT64, (4,))],
)
